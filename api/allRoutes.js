// backend/api/allRoutes.js

/* Este endpoint entrega los datos generales de cada ruta
   para ser usados en la lista de rutas del frontend. */

import express from "express";
import { getDb } from "../db/connection.js";

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const db = await getDb();

    // Obtenemos solo los metadatos necesarios de cada ruta
    const routes = await db.all(
      `SELECT DISTINCT route_id, route_short_name, route_long_name
          FROM routes`
    );

    res.json(routes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
