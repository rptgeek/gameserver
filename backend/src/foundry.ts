import { NextFunction, Request, Response, Router } from "express";
import { DescribeInstancesCommand, EC2Client, RunInstancesCommand, StartInstancesCommand } from "@aws-sdk/client-ec2";
import { GetCommandInvocationCommand, GetParameterCommand, SendCommandCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";

export interface FoundryConfig {
  deploymentId: string;
  launchTemplateId: string;
  url: string;
  commandDocument: string;
}

// This router is mounted AFTER the existing Cognito authentication middleware.
// No instance IDs, shell commands or backup destinations are accepted from clients.
export function createFoundryRouter(ec2: EC2Client, ssm: SSMClient, ddb: DynamoDBDocumentClient, operationsTable: string): Router {
  const router = Router();
  const parameterName = process.env.FOUNDRY_CONFIG_PARAMETER || "/gameserver/dev/foundry/config";
  const wrap = (fn: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };

  async function configuration(): Promise<FoundryConfig | undefined> {
    try {
      const result = await ssm.send(new GetParameterCommand({ Name: parameterName }));
      const value: FoundryConfig = JSON.parse(result.Parameter?.Value || "{}");
      if (!/^lt-[a-f0-9]+$/.test(value.launchTemplateId) || !/^[A-Za-z0-9-]+$/.test(value.deploymentId) ||
          !/^https:\/\/[a-z0-9]+\.cloudfront\.net\/$/.test(value.url) ||
          !/^[A-Za-z0-9_.-]+$/.test(value.commandDocument)) {
        throw new Error("Invalid Foundry deployment configuration");
      }
      return value;
    } catch (error) {
      if ((error as Error).name === "ParameterNotFound") return undefined;
      throw error;
    }
  }

  async function state(value: FoundryConfig): Promise<{ state: string; instanceId?: string; ready: boolean }> {
    const result = await ec2.send(new DescribeInstancesCommand({ Filters: [
      { Name: "tag:ManagedBy", Values: ["foundry-console"] },
      { Name: "tag:FoundryDeployment", Values: [value.deploymentId] },
      { Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped", "shutting-down"] },
    ] }));
    const instances = result.Reservations?.flatMap(item => item.Instances || []) || [];
    if (instances.length > 1) throw new Error("Multiple Foundry servers detected; reconcile before continuing");
    const instance = instances[0];
    return { state: instance?.State?.Name || "not-running", instanceId: instance?.InstanceId,
      ready: Boolean(instance?.Tags?.some(tag => tag.Key === "FoundryReady" && tag.Value === "yes")) };
  }

  router.get("/", wrap(async (_req, res) => {
    const value = await configuration();
    if (!value) { res.json({ configured: false }); return; }
    res.json({ configured: true, url: value.url, ...await state(value) });
  }));

  router.post("/actions", wrap(async (req, res) => {
    const action: unknown = req.body?.action;
    if (action !== "start" && action !== "stop" && action !== "backup") {
      res.status(400).json({ error: "Action must be start, stop, or backup" }); return;
    }
    const value = await configuration();
    if (!value) { res.status(409).json({ error: "Foundry has not been deployed" }); return; }
    const current = await state(value);
    const currentState = current.state;
    if (action === "start") {
      if (currentState === "running" || currentState === "pending") {
        res.json({ action, state: currentState }); return;
      }
      if (currentState !== "stopped" && currentState !== "not-running") {
        res.status(409).json({ error: `Cannot start Foundry while ${currentState}` }); return;
      }
      if (currentState === "stopped") {
        await ec2.send(new StartInstancesCommand({ InstanceIds: [current.instanceId!] }));
      } else {
        // Serialize launches across users/tabs/Lambda invocations. Keep the lease
        // through EC2 eventual consistency and ambiguous network failures.
        const now = Math.floor(Date.now() / 1000);
        try {
          await ddb.send(new PutCommand({ TableName: operationsTable,
            Item: { pk: `foundry-launch#${value.deploymentId}`, leaseUntil: now + 180, ttl: now + 3600 },
            ConditionExpression: "attribute_not_exists(pk) OR leaseUntil < :now", ExpressionAttributeValues: { ":now": now } }));
        } catch (error) {
          if ((error as Error).name === "ConditionalCheckFailedException") {
            res.status(409).json({ error: "A launch is already in progress. Wait for status to update before retrying." }); return;
          }
          throw error;
        }
        // A caller may have observed stale state before acquiring the lease.
        if ((await state(value)).state !== "not-running") {
          res.status(409).json({ error: "Foundry is already starting" }); return;
        }
        await ec2.send(new RunInstancesCommand({ LaunchTemplate: { LaunchTemplateId: value.launchTemplateId, Version: "$Latest" }, MinCount: 1, MaxCount: 1, ClientToken: randomUUID() }));
      }
      res.status(202).json({ action, state: "pending" }); return;
    }
    if (action === "stop" && (currentState === "not-running" || currentState === "shutting-down")) {
      res.json({ action, state: currentState }); return;
    }
    if (currentState !== "running") {
      res.status(409).json({ error: `Cannot ${action} Foundry while ${currentState}` }); return;
    }
    // The host serializes operations, stops Foundry, creates and verifies an S3
    // backup, then either restarts Foundry or schedules an ordinary OS shutdown.
    const result = await ssm.send(new SendCommandCommand({
      InstanceIds: [current.instanceId!], DocumentName: value.commandDocument,
      Parameters: { action: [action] }, TimeoutSeconds: 120,
      Comment: `Foundry ${action} with a verified offline backup`,
    }));
    if (!result.Command?.CommandId) throw new Error("SSM did not return a command ID");
    res.status(202).json({ action, commandId: result.Command.CommandId, instanceId: current.instanceId, state: "backing-up" });
  }));

  router.get("/commands/:commandId", wrap(async (req, res) => {
    const commandId = String(req.params.commandId);
    const instanceId = String(req.query.instanceId || "");
    if (!/^[a-f0-9-]{36}$/.test(commandId) || !/^i-[a-f0-9]+$/.test(instanceId)) {
      res.status(400).json({ error: "Invalid command ID" }); return;
    }
    const value = await configuration();
    if (!value) { res.status(404).json({ error: "Foundry has not been deployed" }); return; }
    try {
      const result = await ssm.send(new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: instanceId }));
      if (result.DocumentName !== value.commandDocument) {
        res.status(404).json({ error: "Foundry command not found" }); return;
      }
      // Do not return arbitrary shell output or credentials to the browser.
      res.json({ commandId, status: result.Status, responseCode: result.ResponseCode });
    } catch (error) {
      if ((error as Error).name === "InvocationDoesNotExist") {
        res.json({ commandId, status: "Pending" }); return;
      }
      throw error;
    }
  }));
  return router;
}
