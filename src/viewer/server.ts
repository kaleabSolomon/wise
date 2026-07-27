import { Hono } from "hono";
import type { DB } from "../store/db.js";
import { listExplanations, getById, latestVersion } from "../store/queries.js";

/**
 * The viewer's read-only HTTP API over the store. Detail includes the previous
 * generation so the client can render both diffs (explanation + code). Building
 * the app from an injected `db` keeps it testable without a running server.
 */
export function createViewerApp(db: DB): Hono {
  const app = new Hono();

  app.get("/api/explanations", (c) => c.json(listExplanations(db)));

  app.get("/api/explanations/:id", (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);

    const row = getById(db, id);
    if (!row) return c.json({ error: "not found" }, 404);

    const prev = latestVersion(db, id);
    return c.json({
      ...row,
      previous: prev
        ? {
            prose: prev.prose,
            code_snapshot: prev.code_snapshot,
            created_at: prev.created_at,
          }
        : null,
    });
  });

  return app;
}
