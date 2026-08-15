/**
 * Entrypoint for the Render Workflow service (`type: workflow` in render.yaml).
 * Importing the module registers every task(); startTaskServer() then hands control
 * to Render, which invokes tasks on demand.
 */
import { startTaskServer } from "@renderinc/sdk/workflows";
import "./pipeline/workflow.js";

await startTaskServer();
