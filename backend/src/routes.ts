import { randomUUID } from "crypto";
import { NextFunction, Request, Response, Router } from "express";
import {
  DescribeInstancesCommand,
  RebootInstancesCommand,
  RunInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import {
  GetCommandInvocationCommand,
  SendCommandCommand,
} from "@aws-sdk/client-ssm";
import {
  CreateLogStreamCommand,
  GetLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { createRemoteJWKSet, jwtVerify, JWTPayload } from "jose";

import { config } from "./config";
import { ddbClient, ec2Client, logsClient, ssmClient } from "./aws";
import { BaseRepository } from "./models/repositories";
import {
  ConfigHistoryItem,
  ConfigItem,
  IdempotencyLookupItem,
  InstanceCreateRequest,
  InstanceItem,
  GameItem,
  GameProfileItem,
  WorldPresetItem,
  OperationItem,
  SaveProfileRequest,
  SaveWorldRequest,
  UserContext,
  SupportedAction,
} from "./models/types";

const gamesRepository = new BaseRepository<GameItem>(config.tables.games, ddbClient);
const gameProfilesRepository = new BaseRepository<GameProfileItem>(
  config.tables.games,
  ddbClient,
);
const worldPresetsRepository = new BaseRepository<WorldPresetItem>(
  config.tables.games,
  ddbClient,
);
const instanceRepository = new BaseRepository<InstanceItem>(
  config.tables.instances,
  ddbClient,
);
const operationRepository = new BaseRepository<OperationItem>(
  config.tables.operations,
  ddbClient,
);
const configRepository = new BaseRepository<ConfigItem>(
  config.tables.instanceConfig,
  ddbClient,
);
const configHistoryRepository = new BaseRepository<ConfigHistoryItem>(
  config.tables.configHistory,
  ddbClient,
);
const idempotencyRepository = new BaseRepository<IdempotencyLookupItem>(
  config.tables.operations,
  ddbClient,
);

type AuthenticatedRequest = Request & { user: UserContext };

const jwksUrl =
  config.auth.userPoolId && config.auth.clientId
    ? new URL(
        `https://cognito-idp.${config.auth.cognitoRegion}.amazonaws.com/${config.auth.userPoolId}/.well-known/jwks.json`,
      )
    : null;
const jwks = jwksUrl ? createRemoteJWKSet(jwksUrl) : null;

function authRole(payload: JWTPayload): string {
  const claim = payload["custom:role"] as unknown;
  if (typeof claim === "string" && claim.trim()) return claim.toLowerCase().trim();
  if (Array.isArray(claim) && claim.length > 0)
    return String(claim[0]).toLowerCase();
  return "user";
}

async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authReq = req as AuthenticatedRequest;
  if (
    config.auth.authDisabled ||
    !config.auth.userPoolId ||
    !config.auth.clientId ||
    !jwks
  ) {
    authReq.user = {
      sub: "system",
      username: "system",
      role: config.auth.defaultRole,
    };
    next();
    return;
  }

  const authorization = req.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Authorization header missing" });
    return;
  }

  const token = authorization.slice("Bearer ".length);
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer:
        config.auth.issuerTemplate ??
        `https://cognito-idp.${config.auth.cognitoRegion}.amazonaws.com/${config.auth.userPoolId}`,
      audience: config.auth.clientId,
    });

    const issuerPayload = (payload as Record<string, unknown> | undefined) ?? {};
    authReq.user = {
      sub: String(payload.sub ?? "unknown"),
      username: String(
        issuerPayload.email ??
          issuerPayload["cognito:username"] ??
          payload.sub ??
          "unknown",
      ),
      role: authRole(payload),
    };
    next();
  } catch (error) {
    res.status(401).json({ error: "Invalid token", details: (error as Error).message });
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function profilePk(gameId: string, profileId: string): string {
  return `game-profile#${gameId}#${profileId}`;
}

function worldPk(gameId: string, worldId: string): string {
  return `game-world#${gameId}#${worldId}`;
}

function parseProfileListEntry(profile: GameProfileItem): GameProfileItem {
  return profile;
}

function parseWorldListEntry(world: WorldPresetItem): WorldPresetItem {
  return world;
}

function withAsync<T = void>(
  fn: (req: Request, res: Response) => Promise<T>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

function asInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.max(parsed, 1), 1000);
}

function cleanIdempotencyKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 256) : undefined;
}

function operationPk(operationId: string): string {
  return `operation#${operationId}`;
}

function idempotencyPk(key: string): string {
  return `idempotency#${key}`;
}

function normalizeLogSource(source: unknown): "bootstrap" | "server" {
  return source === "bootstrap" ? "bootstrap" : "server";
}

function logLocation(instanceId: string, source: "bootstrap" | "server") {
  return {
    logGroupName:
      source === "bootstrap"
        ? `${config.logs.bootstrapPrefix}/${instanceId}`
        : `${config.logs.serverPrefix}/${instanceId}`,
    logStreamName: instanceId,
  };
}

function isSupportedAction(value: unknown): value is SupportedAction {
  return (
    value === "start" ||
    value === "stop" ||
    value === "restart" ||
    value === "terminate" ||
    value === "reboot"
  );
}

async function lookupOperationByIdempotency(
  key: string | undefined,
): Promise<OperationItem | undefined> {
  if (!key) return undefined;
  const mapping = await idempotencyRepository.get(idempotencyPk(key));
  if (!mapping?.operationId) return undefined;
  return operationRepository.get(operationPk(mapping.operationId));
}

function expectedEc2State(action: OperationItem["action"]): string | undefined {
  if (action === "start" || action === "reboot" || action === "restart")
    return "running";
  if (action === "stop") return "stopped";
  if (action === "terminate") return "terminated";
  return undefined;
}

async function refreshEc2State(instanceId: string): Promise<string | undefined> {
  try {
    const result = await ec2Client.send(
      new DescribeInstancesCommand({ InstanceIds: [instanceId] }),
    );
    return result.Reservations?.[0]?.Instances?.[0]?.State?.Name;
  } catch {
    return undefined;
  }
}

async function createOperation(
  req: AuthenticatedRequest,
  action: OperationItem["action"],
  instanceIds: string[],
  payload?: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<{ operation: OperationItem; replay: boolean }> {
  const normalized = cleanIdempotencyKey(idempotencyKey);
  const existing = await lookupOperationByIdempotency(normalized);
  if (existing) {
    return { operation: existing, replay: true };
  }

  const now = new Date().toISOString();
  const operationId = randomUUID();
  const operation: OperationItem = {
    pk: operationPk(operationId),
    operationId,
    action,
    instanceIds,
    status: "running",
    createdAt: now,
    updatedAt: now,
    createdBy: req.user.sub,
    userRole: req.user.role,
    payload,
  };
  await operationRepository.put(operation);

  if (normalized) {
    const recorded = await idempotencyRepository.putIfNotExists({
      pk: idempotencyPk(normalized),
      kind: "idempotency",
      operationId,
      createdAt: now,
    });
    if (!recorded) {
      const again = await lookupOperationByIdempotency(normalized);
      if (again) {
        return { operation: again, replay: true };
      }
    }
  }

  return { operation, replay: false };
}

async function saveOperation(
  operation: OperationItem,
  patch: Partial<OperationItem>,
): Promise<OperationItem> {
  const updated = { ...operation, ...patch, updatedAt: new Date().toISOString() };
  await operationRepository.put(updated);
  return updated;
}

async function launchSsmCommand(
  req: AuthenticatedRequest,
  instanceIds: string[],
  action: "bootstrap" | "update",
  documentName: string,
  idempotencyKey?: string,
): Promise<OperationItem> {
  const { operation, replay } = await createOperation(
    req,
    action,
    instanceIds,
    { action, documentName },
    idempotencyKey,
  );
  if (replay) return operation;

  try {
    const command = await ssmClient.send(
      new SendCommandCommand({
        InstanceIds: instanceIds,
        DocumentName: documentName,
        Comment: `7d2d-console:${action}`,
        Parameters: { action: [action] },
      }),
    );
    return saveOperation(operation, {
      commandId: command.Command?.CommandId,
      commandDocument: documentName,
      status: "running",
    });
  } catch (error) {
    return saveOperation(operation, {
      status: "failed",
      error: (error as Error).message,
    });
  }
}

async function createInstancesForSpec(
  req: AuthenticatedRequest,
  spec: InstanceCreateRequest,
): Promise<string[]> {
  const instanceType = spec.instanceType ?? config.ec2.defaultInstanceType;
  const imageId = spec.amiId ?? config.ec2.defaultAmiId;
  const count = Math.min(Math.max(Math.floor(Number(spec.count ?? 1)), 1), 20);
  const gameId = String(spec.gameId);

  if (!imageId) {
    throw new Error("No AMI id configured and no amiId in request");
  }
  if (!spec.gameId) {
    throw new Error("Missing gameId");
  }

  let selectedProfile: GameProfileItem | undefined;
  if (spec.selectedProfileId) {
    selectedProfile = await gameProfilesRepository.get(
      profilePk(gameId, spec.selectedProfileId),
    );
    if (!selectedProfile) {
      const fallback = (await gameProfilesRepository.scanByPrefix("pk", `game-profile#${gameId}#`))
        .find((candidate) => candidate.profileId === spec.selectedProfileId);
      selectedProfile = fallback;
    }
    if (!selectedProfile || selectedProfile.gameId !== gameId) {
      throw new Error(`Unknown profile id: ${spec.selectedProfileId}`);
    }
  }

  let selectedWorld: WorldPresetItem | undefined;
  if (spec.selectedWorldId) {
    selectedWorld = await worldPresetsRepository.get(
      worldPk(gameId, spec.selectedWorldId),
    );
    if (!selectedWorld) {
      const fallback = (await worldPresetsRepository.scanByPrefix("pk", `game-world#${gameId}#`))
        .find((candidate) => candidate.worldId === spec.selectedWorldId);
      selectedWorld = fallback;
    }
    if (!selectedWorld || selectedWorld.gameId !== gameId) {
      throw new Error(`Unknown world id: ${spec.selectedWorldId}`);
    }
  }

  const requestConfig = isObject(spec.config) ? spec.config : {};
  const profileConfig =
    selectedProfile && isObject(selectedProfile.config) ? selectedProfile.config : {};
  const worldSeed =
    selectedWorld && isObject(selectedWorld.worldSeed) ? selectedWorld.worldSeed : undefined;
  const mergedConfig = { ...profileConfig, ...requestConfig, ...(worldSeed ? { worldSeed } : {}) };

  const result = await ec2Client.send(
    new RunInstancesCommand({
      ImageId: imageId,
      InstanceType: instanceType,
      MinCount: count,
      MaxCount: count,
      KeyName: spec.keyName,
      SubnetId: spec.subnetId ?? config.ec2.defaultSubnetId,
      SecurityGroupIds:
        spec.securityGroupIds?.length
          ? spec.securityGroupIds
          : config.ec2.defaultSecurityGroupIds,
      TagSpecifications: [
        {
          ResourceType: "instance",
          Tags: [
            { Key: "GameId", Value: spec.gameId },
            { Key: "ManagedBy", Value: "7d2d-console" },
            ...(Object.entries(spec.tags ?? {}).map(([key, value]) => ({
              Key: key,
              Value: value,
            })) ?? []),
            ...(spec.selectedProfileId
              ? [{ Key: "GameProfileId", Value: spec.selectedProfileId }]
              : []),
            ...(spec.selectedWorldId
              ? [{ Key: "GameWorldId", Value: spec.selectedWorldId }]
              : []),
            ...(spec.worldName ? [{ Key: "WorldName", Value: spec.worldName }] : []),
          ],
        },
      ],
    }),
  );

  const createdIds = (result.Instances ?? [])
    .map((instance) => instance.InstanceId)
    .filter((instanceId): instanceId is string => Boolean(instanceId));
  const now = new Date().toISOString();

  for (const instanceId of createdIds) {
    await instanceRepository.put({
      pk: instanceId,
      instanceId,
      gameId: spec.gameId,
      status: "creating",
      ec2State: "pending",
      createdBy: req.user.sub,
      createdAt: now,
      updatedAt: now,
      amiId: imageId,
      instanceType,
      subnetId: spec.subnetId ?? config.ec2.defaultSubnetId,
      securityGroupIds:
        spec.securityGroupIds?.length
          ? spec.securityGroupIds
          : config.ec2.defaultSecurityGroupIds,
      tags: { ...(spec.tags ?? {}), gameId: spec.gameId },
      bootstrapProfile: spec.bootstrapAction ? `requested:${spec.bootstrapAction}` : undefined,
      profileType: spec.bootstrapAction,
      selectedProfileId: spec.selectedProfileId,
      selectedWorldId: spec.selectedWorldId,
      worldName: spec.worldName,
    });

    if (Object.keys(mergedConfig).length > 0) {
      await configRepository.put({
        pk: instanceId,
        instanceId,
        values: mergedConfig,
        updatedAt: now,
        updatedBy: req.user.sub,
      });
    }
  }

  return createdIds;
}

async function latestOperationForInstance(
  instanceId: string,
): Promise<OperationItem | undefined> {
  const operations = await operationRepository.scan({
    expression: "contains(instanceIds, :instanceId)",
    values: { ":instanceId": instanceId },
  });
  operations.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return operations[0];
}

async function readLogEvents(
  instanceId: string,
  source: "bootstrap" | "server",
  nextToken?: string,
  limit = 100,
) {
  const { logGroupName, logStreamName } = logLocation(instanceId, source);
  const response = await logsClient.send(
    new GetLogEventsCommand({
      logGroupName,
      logStreamName,
      startFromHead: false,
      limit,
      nextToken,
    }),
  );
  return {
    source,
    logGroupName,
    logStreamName,
    nextToken: response.nextForwardToken ?? null,
    events: (response.events ?? []).map((event) => ({
      timestamp: event.timestamp,
      message: event.message,
      ingestionTime: event.ingestionTime,
    })),
  };
}

async function executeInstanceAction(
  req: AuthenticatedRequest,
  instanceId: string,
  action: SupportedAction,
  requireAdmin = false,
): Promise<OperationItem> {
  if (requireAdmin && req.user.role !== "admin") {
    const error = new Error("admin role required") as Error & { statusCode: number };
    error.statusCode = 403;
    throw error;
  }

  const idem = cleanIdempotencyKey(req.headers["idempotency-key"]);
  const existing = await lookupOperationByIdempotency(idem);
  if (existing && existing.instanceIds.includes(instanceId) && existing.action === action) {
    return existing;
  }

  const { operation: createdOp, replay } = await createOperation(
    req,
    action,
    [instanceId],
    { action },
    idem,
  );
  let operation = createdOp;

  if (replay) {
    return operation;
  }

  try {
    if (action === "start") {
      await ec2Client.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
    } else if (action === "stop") {
      await ec2Client.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
    } else if (action === "restart" || action === "reboot") {
      await ec2Client.send(new RebootInstancesCommand({ InstanceIds: [instanceId] }));
    } else if (action === "terminate") {
      await ec2Client.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
    }
    operation = await saveOperation(operation, { status: "succeeded" });
  } catch (error) {
    operation = await saveOperation(operation, {
      status: "failed",
      error: (error as Error).message,
    });
  }

  const instance = await instanceRepository.get(instanceId);
  if (instance) {
    await instanceRepository.put({
      ...instance,
      status: operation.status,
      updatedAt: new Date().toISOString(),
    });
  }

  return operation;
}

export function createRouter(): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ status: "ok", time: new Date().toISOString(), env: config.nodeEnv });
  });

  router.use(requireAuth);

  router.get(
    "/v1/games",
    withAsync(async (_req, res) => {
      const rawGames = await gamesRepository.scan();
      const games = rawGames
        .filter((game) => {
          if (game.kind && game.kind !== "game") {
            return false;
          }
          return Boolean(game.gameId);
        })
        .map((game) =>
          game.kind ? game : { ...game, kind: "game" },
        ) as GameItem[];
      games.sort((a, b) => {
        const aName = a.name ?? a.gameId ?? "";
        const bName = b.name ?? b.gameId ?? "";
        return aName.localeCompare(bName);
      });
      res.json({ games });
    }),
  );

  router.get(
    "/v1/games/:gameId/profiles",
    withAsync(async (req, res) => {
      const { gameId } = req.params;
      const allProfiles = await gameProfilesRepository.scan();
      const profiles = allProfiles
        .filter(
          (profile) =>
            profile.kind === "game-profile" && profile.gameId === gameId,
        )
        .map((profile) => parseProfileListEntry(profile));
      profiles.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      res.json({ profiles });
    }),
  );

  router.post(
    "/v1/games/:gameId/profiles",
    withAsync(async (req, res) => {
      const authReq = req as AuthenticatedRequest;
      const { gameId } = req.params;
      const body = req.body as SaveProfileRequest;
      const name = typeof body?.name === "string" ? body.name.trim() : "";
      if (!name) {
        res.status(400).json({ error: "name is required" });
        return;
      }
      if (!isObject(body?.config)) {
        res.status(400).json({ error: "config must be an object" });
        return;
      }

      const now = new Date().toISOString();
      const profileId = randomUUID();
      const profile: GameProfileItem = {
        pk: profilePk(gameId, profileId),
        gameId,
        kind: "game-profile",
        profileId,
        name,
        description: body.description,
        config: body.config,
        worldId: body.worldId,
        createdAt: now,
        updatedAt: now,
        createdBy: authReq.user.sub,
      };
      await gameProfilesRepository.put(profile);
      res.status(201).json({ profile });
    }),
  );

  router.get(
    "/v1/games/:gameId/worlds",
    withAsync(async (req, res) => {
      const { gameId } = req.params;
      const allWorlds = await worldPresetsRepository.scan();
      const worlds = allWorlds
        .filter((world) => world.kind === "game-world" && world.gameId === gameId)
        .map((world) => parseWorldListEntry(world));
      worlds.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      res.json({ worlds });
    }),
  );

  router.post(
    "/v1/games/:gameId/worlds",
    withAsync(async (req, res) => {
      const authReq = req as AuthenticatedRequest;
      const { gameId } = req.params;
      const body = req.body as SaveWorldRequest;
      const name = typeof body?.name === "string" ? body.name.trim() : "";
      if (!name) {
        res.status(400).json({ error: "name is required" });
        return;
      }
      if (!isObject(body?.worldSeed)) {
        res.status(400).json({ error: "worldSeed must be an object" });
        return;
      }

      const now = new Date().toISOString();
      const worldId = randomUUID();
      const world: WorldPresetItem = {
        pk: worldPk(gameId, worldId),
        gameId,
        kind: "game-world",
        worldId,
        name,
        description: body.description,
        worldSeed: body.worldSeed,
        createdAt: now,
        updatedAt: now,
        createdBy: authReq.user.sub,
      };
      await worldPresetsRepository.put(world);
      res.status(201).json({ world });
    }),
  );

  router.get(
    "/v1/instances",
    withAsync(async (req, res) => {
      const gameId = req.query.gameId ? String(req.query.gameId) : undefined;
      const instances = gameId
        ? await instanceRepository.scanByField("gameId", gameId)
        : await instanceRepository.scan();
      res.json({ instances });
    }),
  );

  router.get(
    "/v1/instances/:instanceId",
    withAsync(async (req, res) => {
      const instanceId = req.params.instanceId;
      const instance = await instanceRepository.get(instanceId);
      if (instance) {
        res.json({ instance });
        return;
      }

      const fallbackState = await refreshEc2State(instanceId);
      if (!fallbackState) {
        res.status(404).json({ error: "instance not found" });
        return;
      }
      res.json({
        instance: {
          pk: instanceId,
          instanceId,
          gameId: "legacy",
          status: "legacy",
          ec2State: fallbackState,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });
    }),
  );

  router.post(
    "/v1/instances",
    withAsync(async (req, res) => {
      const authReq = req as AuthenticatedRequest;
      const idempotencyKey = cleanIdempotencyKey(req.headers["idempotency-key"]);
      const requestBody = (req.body ?? {}) as Record<string, unknown>;
      const specs: InstanceCreateRequest[] = Array.isArray(requestBody.instances)
        ? (requestBody.instances as InstanceCreateRequest[])
        : [requestBody as InstanceCreateRequest];

      if (specs.length === 0) {
        res.status(400).json({ error: "No instance payload supplied" });
        return;
      }

      const replayLookup = await lookupOperationByIdempotency(idempotencyKey);
      if (replayLookup?.action === "create") {
        res.json(replayLookup);
        return;
      }

      const { operation: createdOperation, replay } = await createOperation(
        authReq,
        "create",
        [],
        { count: specs.length },
        idempotencyKey,
      );
      if (replay) {
        res.json(createdOperation);
        return;
      }

      const allIds: string[] = [];
      let operation = createdOperation;
      try {
        for (const rawSpec of specs) {
          const gameId =
            typeof rawSpec.gameId === "string"
              ? rawSpec.gameId.trim()
              : String(rawSpec.gameId ?? "").trim();
          if (!gameId) {
            throw new Error("Missing gameId");
          }
          const spec: InstanceCreateRequest = {
            gameId,
            count: rawSpec.count,
            amiId: rawSpec.amiId,
            instanceType: rawSpec.instanceType,
            keyName: rawSpec.keyName,
            subnetId: rawSpec.subnetId,
            securityGroupIds: rawSpec.securityGroupIds,
            tags: rawSpec.tags,
            bootstrap: rawSpec.bootstrap,
            bootstrapAction: rawSpec.bootstrapAction ?? (rawSpec.bootstrap ? "bootstrap" : undefined),
            bootstrapDocumentName: rawSpec.bootstrapDocumentName,
            config: isObject(rawSpec.config) ? rawSpec.config : undefined,
            selectedProfileId:
              typeof rawSpec.selectedProfileId === "string"
                ? rawSpec.selectedProfileId.trim()
                : undefined,
            selectedWorldId:
              typeof rawSpec.selectedWorldId === "string"
                ? rawSpec.selectedWorldId.trim()
                : undefined,
            worldName:
              typeof rawSpec.worldName === "string" ? rawSpec.worldName.trim() : undefined,
          };
          const created = await createInstancesForSpec(authReq, spec);
          allIds.push(...created);
          operation = await saveOperation(operation, { instanceIds: [...operation.instanceIds, ...created] });
        }

        const bootstrapSpec = specs.find((spec) => spec.bootstrap || spec.bootstrapAction);
        if (bootstrapSpec && allIds.length > 0) {
          await launchSsmCommand(
            authReq,
            allIds,
            bootstrapSpec.bootstrapAction ?? "bootstrap",
            bootstrapSpec.bootstrapDocumentName ?? config.ssm.bootstrapDocumentName,
            idempotencyKey,
          );
        }

        operation = await saveOperation(operation, {
          status: "succeeded",
          instanceIds: allIds,
        });
      } catch (error) {
        operation = await saveOperation(operation, {
          status: "failed",
          error: (error as Error).message,
        });
      }

      res.status(operation.status === "failed" ? 500 : 200).json(operation);
    }),
  );

  router.post(
    "/v1/instances/:instanceId/start",
    withAsync(async (req, res) => {
      const authReq = req as AuthenticatedRequest;
      const operation = await executeInstanceAction(authReq, req.params.instanceId, "start");
      res.json(operation);
    }),
  );

  router.post(
    "/v1/instances/:instanceId/stop",
    withAsync(async (req, res) => {
      const authReq = req as AuthenticatedRequest;
      const operation = await executeInstanceAction(authReq, req.params.instanceId, "stop");
      res.json(operation);
    }),
  );

  router.post(
    "/v1/instances/:instanceId/restart",
    withAsync(async (req, res) => {
      const authReq = req as AuthenticatedRequest;
      const operation = await executeInstanceAction(
        authReq,
        req.params.instanceId,
        "restart",
        true,
      );
      res.json(operation);
    }),
  );

  router.post(
    "/v1/instances/:instanceId/reboot",
    withAsync(async (req, res) => {
      const authReq = req as AuthenticatedRequest;
      const operation = await executeInstanceAction(
        authReq,
        req.params.instanceId,
        "reboot",
        false,
      );
      res.json(operation);
    }),
  );

  router.post(
    "/v1/instances/:instanceId/terminate",
    withAsync(async (req, res) => {
      const authReq = req as AuthenticatedRequest;
      const operation = await executeInstanceAction(
        authReq,
        req.params.instanceId,
        "terminate",
        true,
      );
      res.json(operation);
    }),
  );

  router.post(
    "/v1/instances/:instanceId/action",
    withAsync(async (req, res) => {
      const authReq = req as AuthenticatedRequest;
      const instanceId = req.params.instanceId;
      const action = req.body?.action;
      if (!isSupportedAction(action)) {
        res.status(400).json({ error: "action must be start|stop|restart|terminate|reboot" });
        return;
      }

      const operation = await executeInstanceAction(
        authReq,
        instanceId,
        action,
        action === "restart" || action === "terminate",
      );
      res.json(operation);
    }),
  );

  router.get(
    "/v1/instances/:instanceId/status",
    withAsync(async (req, res) => {
      const instanceId = req.params.instanceId;
      const latest = await latestOperationForInstance(instanceId);
      const ec2State = await refreshEc2State(instanceId);

      if (latest?.commandId && (latest.action === "bootstrap" || latest.action === "update")) {
        try {
          const invocation = await ssmClient.send(
            new GetCommandInvocationCommand({
              CommandId: latest.commandId,
              InstanceId: instanceId,
            }),
          );
          res.json({
            instanceId,
            ec2State,
            latestOperation: latest,
            commandStatus: {
              status: invocation.Status,
              executionStartDate: invocation.ExecutionStartDate?.toISOString(),
              executionEndDate: invocation.ExecutionEndDate?.toISOString(),
              responseCode: invocation.ResponseCode,
            },
          });
          return;
        } catch {
          // fallback to ec2 state below
        }
      }

      if (latest) {
        const expected = expectedEc2State(latest.action);
        const derivedStatus =
          latest.status === "running" && expected && ec2State === expected
            ? "succeeded"
            : latest.status;
        res.json({ instanceId, ec2State, latestOperation: { ...latest, status: derivedStatus } });
        return;
      }

      res.json({ instanceId, ec2State, latestOperation: null });
    }),
  );

  router.get(
    "/v1/instances/:instanceId/logs",
    withAsync(async (req, res) => {
      const instanceId = req.params.instanceId;
      const source = normalizeLogSource(req.query.source);
      const limit = asInt(req.query.limit, 100);
      const nextToken =
        typeof req.query.nextToken === "string" ? req.query.nextToken : undefined;
      const payload = await readLogEvents(instanceId, source, nextToken, limit);
      res.json(payload);
    }),
  );

  router.get(
    "/v1/instances/:instanceId/logs/:source",
    withAsync(async (req, res) => {
      const instanceId = req.params.instanceId;
      const source = normalizeLogSource(req.params.source);
      const limit = asInt(req.query.limit, 100);
      const nextToken =
        typeof req.query.nextToken === "string" ? req.query.nextToken : undefined;
      const payload = await readLogEvents(instanceId, source, nextToken, limit);
      res.json(payload);
    }),
  );

  router.post(
    "/v1/instances/:instanceId/logs/stream",
    withAsync(async (req, res) => {
      const instanceId = req.params.instanceId;
      const source = normalizeLogSource(req.body?.source);
      const { logGroupName } = logLocation(instanceId, source);
      const streamName = `${instanceId}-${source}-${Date.now()}`;
      await logsClient.send(
        new CreateLogStreamCommand({
          logGroupName,
          logStreamName: streamName,
        }),
      );
      res.json({ instanceId, source, logGroupName, streamName });
    }),
  );

  router.get(
    "/v1/instances/:instanceId/config",
    withAsync(async (req, res) => {
      const instanceId = req.params.instanceId;
      const item = await configRepository.get(instanceId);
      if (!item) {
        const instance = await instanceRepository.get(instanceId);
        if (!instance) {
          res.status(404).json({ error: "instance not found" });
          return;
        }
        res.json({ instanceId, config: {}, updatedAt: null, updatedBy: null });
        return;
      }
      res.json({
        instanceId,
        config: item.values,
        updatedAt: item.updatedAt,
        updatedBy: item.updatedBy,
      });
    }),
  );

  router.patch(
    "/v1/instances/:instanceId/config",
    withAsync(async (req, res) => {
      const authReq = req as AuthenticatedRequest;
      const instanceId = req.params.instanceId;
      const body = req.body as Record<string, unknown>;
      const bootstrapAction =
        body?.action === "bootstrap" || body?.action === "update"
          ? (body.action as "bootstrap" | "update")
          : undefined;

      const rawConfigPayload =
        body?.config && typeof body.config === "object" && !Array.isArray(body.config)
          ? (body.config as Record<string, unknown>)
          : body;
      const configPayload =
        rawConfigPayload && typeof rawConfigPayload === "object"
          ? Object.fromEntries(
              Object.entries(rawConfigPayload).filter(([key]) => key !== "action"),
            )
          : {};

      if (!bootstrapAction && Object.keys(configPayload).length === 0) {
        res.status(400).json({ error: "No config changes supplied" });
        return;
      }

      const existing = await configRepository.get(instanceId);
      const prevValues = existing?.values ?? {};
      const nextValues = bootstrapAction
        ? { ...prevValues, ...configPayload }
        : { ...prevValues, ...configPayload };

      const now = new Date().toISOString();
      await configRepository.put({
        pk: instanceId,
        instanceId,
        values: nextValues,
        updatedAt: now,
        updatedBy: authReq.user.sub,
      });
      await configHistoryRepository.put({
        pk: `config_history#${instanceId}#${Date.now()}`,
        instanceId,
        operationId: randomUUID(),
        previous: prevValues,
        next: nextValues,
        createdAt: now,
        updatedBy: authReq.user.sub,
      });

      if (bootstrapAction) {
        const commandDocument =
          bootstrapAction === "bootstrap"
            ? config.ssm.bootstrapDocumentName
            : config.ssm.updateDocumentName;
        const operation = await launchSsmCommand(
          authReq,
          [instanceId],
          bootstrapAction,
          commandDocument,
        );
        res.json({
          instanceId,
          config: nextValues,
          operation,
        });
        return;
      }

      res.json({ instanceId, config: nextValues });
    }),
  );

  router.get(
    "/v1/operations/:operationId",
    withAsync(async (req, res) => {
      const operation = await operationRepository.get(
        operationPk(req.params.operationId),
      );
      if (!operation) {
        res.status(404).json({ error: "operation not found" });
        return;
      }
      res.json({ operation });
    }),
  );

  router.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const status =
      (error as { statusCode?: number })?.statusCode ??
      (error as { status?: number })?.status ??
      500;
    const message = error instanceof Error ? error.message : "internal error";
    res.status(status).json({ error: message });
  });

  return router;
}
