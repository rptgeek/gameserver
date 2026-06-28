import { createServer, proxy } from "@vendia/serverless-express";
import { app } from "./app";

const server = createServer(app);

export const handler = async (event: unknown, context: unknown) => {
  return proxy(server, event, context);
};

