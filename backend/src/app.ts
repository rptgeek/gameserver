import express from "express";
import { createRouter } from "./routes";

export const app = express();

app.use(express.json());
app.use("/", createRouter());

