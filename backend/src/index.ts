import express from "express";
import { createRouter } from "./routes";
import { config } from "./config";

const app = express();

app.use(express.json());
app.use("/", createRouter());

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`web console api listening on :${config.port}`);
});
