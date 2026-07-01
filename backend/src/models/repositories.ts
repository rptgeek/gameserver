import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, DeleteCommand, GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

export class BaseRepository<T extends { pk: string }> {
  constructor(
    private readonly tableName: string,
    private readonly ddb: DynamoDBDocumentClient,
  ) {}

  async get(pk: string): Promise<T | null> {
    const response = await this.ddb.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk },
      }),
    );
    return (response.Item as T) ?? null;
  }

  async put(item: T): Promise<void> {
    await this.ddb.send(new PutCommand({ TableName: this.tableName, Item: item }));
  }

  async delete(pk: string): Promise<void> {
    await this.ddb.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { pk },
      }),
    );
  }

  async putIfNotExists(item: T): Promise<boolean> {
    try {
      await this.ddb.send(
        new PutCommand({
          TableName: this.tableName,
          Item: item,
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
      return true;
    } catch (error: unknown) {
      if (error instanceof ConditionalCheckFailedException) {
        return false;
      }
      throw error;
    }
  }

  async scan(filter?: {
    expression: string;
    names?: Record<string, string>;
    values?: Record<string, unknown>;
  }): Promise<T[]> {
    const response = await this.ddb.send(
      new ScanCommand({
        TableName: this.tableName,
        ...(filter
          ? {
              FilterExpression: filter.expression,
              ExpressionAttributeNames: filter.names,
              ExpressionAttributeValues: filter.values,
            }
          : {}),
      }),
    );
    return (response.Items as T[]) ?? [];
  }

  async scanByField(field: string, value: unknown): Promise<T[]> {
    return this.scan({
      expression: `#f = :v`,
      names: { "#f": field },
      values: { ":v": value },
    });
  }

  async scanByPrefix(field: string, prefix: string): Promise<T[]> {
    return this.scan({
      expression: `begins_with(#f, :prefix)`,
      names: { "#f": field },
      values: { ":prefix": prefix },
    });
  }
}
