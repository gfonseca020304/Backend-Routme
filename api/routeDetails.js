// backend/api/routeDetails.js

/* Este endpoint entrega lso datos necesarios para mostrar
   el mapa de la ruta seleccionada */
import express from "express";
import { getDb } from "../db/connection.js";

const router = express.Router();

router.get("/:route_id", async (req, res) => {
  const { route_id } = req.params;

  if (!route_id) {
    return res.status(400).json({ error: "Missing route_id" });
  }

  try {
    const db = await getDb();

    // Escogemoos un trip de la ruta por su ID
    const trip = await db.get(
      `SELECT trip_id, shape_id FROM trips WHERE route_id = ? LIMIT 1`,
      [route_id]
    );

    if (!trip) {
      return res.status(404).json({ error: "No trip found for this route" });
    }

    // Obtenemos el shape de ese trip
    const shape = await db.all(
      `SELECT shape_pt_lat AS lat, shape_pt_lon AS lon, shape_pt_sequence
       FROM shapes WHERE shape_id = ? ORDER BY shape_pt_sequence`,
      [trip.shape_id]
    );

    // Obtenemos los stops de ese trip
    const stops = await db.all(
      `SELECT s.stop_name, s.stop_lat AS lat, s.stop_lon AS lon
       FROM stop_times st
       JOIN stops s ON s.stop_id = st.stop_id
       WHERE st.trip_id = ?
       ORDER BY st.stop_sequence`,
      [trip.trip_id]
    );

    // Entregamos la informacion necesaria para el mapa
    // (shape y stops) junto con el route_id
    res.json({
      route_id,
      shape,
      stops,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
