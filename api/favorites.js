import express from "express";
import { getDb } from "../db/connection.js";
import { verifyToken } from "../middleware/authMiddleware.js";

const router = express.Router();

// ✅ GET favorites for the logged-in user
router.get("/", verifyToken, async (req, res) => {
  const user_id = req.user.id;

  try {
    const db = await getDb();

    const favorites = await db.all(
        `SELECT f.*, s1.stop_name AS from_stop, s2.stop_name AS to_stop
             FROM favorites f
             JOIN stops s1 ON s1.stop_id = f.from_stop_id
             JOIN stops s2 ON s2.stop_id = f.to_stop_id
             WHERE f.user_id = ?`,
        [user_id]
    );

    const results = [];

    for (const fav of favorites) {
      console.log("🔍 Looking up favorite:", fav);

      const trip = await db.get(
          `SELECT t.trip_id, t.shape_id, r.route_short_name, r.route_long_name
                 FROM trips t
                 JOIN routes r ON r.route_id = t.route_id
                 JOIN stop_times st1 ON st1.trip_id = t.trip_id
                 JOIN stop_times st2 ON st2.trip_id = t.trip_id
                 WHERE st1.stop_id = ? AND st2.stop_id = ?
                 AND st1.stop_sequence < st2.stop_sequence
                 AND t.route_id = ?
                 LIMIT 1`,
          [fav.from_stop_id, fav.to_stop_id, fav.route_id]
      );

      console.log("🧠 Trip found:", trip);
      if (!trip) {
        results.push({
          label: fav.label,
          route_short_name: fav.route_short_name || fav.route_id,
          route_long_name: fav.route_long_name || 'Ruta desconocida',
          from_stop_id: fav.from_stop_id,
          to_stop_id: fav.to_stop_id,
          route_id: fav.route_id,
          from_stop: fav.from_stop,
          to_stop: fav.to_stop,
          shape: [],
        });
        continue;
      }

      const shape = await db.all(
          `SELECT shape_pt_lat AS lat, shape_pt_lon AS lon, shape_pt_sequence
                 FROM shapes WHERE shape_id = ? ORDER BY shape_pt_sequence`,
          [trip.shape_id]
      );

      const fromCoords = await db.get(
          `SELECT stop_lat AS lat, stop_lon AS lon FROM stops WHERE stop_id = ?`,
          [fav.from_stop_id]
      );
      const toCoords = await db.get(
          `SELECT stop_lat AS lat, stop_lon AS lon FROM stops WHERE stop_id = ?`,
          [fav.to_stop_id]
      );

      const haversine = (lat1, lon1, lat2, lon2) => {
        const R = 6371;
        const dLat = ((lat2 - lat1) * Math.PI) / 180;
        const dLon = ((lon2 - lon1) * Math.PI) / 180;
        const a =
            Math.sin(dLat / 2) ** 2 +
            Math.cos((lat1 * Math.PI) / 180) *
            Math.cos((lat2 * Math.PI) / 180) *
            Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      };

      const closestIndex = (list, point) =>
          list.reduce((closestIdx, curr, i, arr) => {
            const dist = haversine(curr.lat, curr.lon, point.lat, point.lon);
            const closestDist = haversine(
                arr[closestIdx].lat,
                arr[closestIdx].lon,
                point.lat,
                point.lon
            );
            return dist < closestDist ? i : closestIdx;
          }, 0);

      const fromIdx = closestIndex(shape, fromCoords);
      const toIdx = closestIndex(shape, toCoords);
      const slicedShape = shape.slice(
          Math.min(fromIdx, toIdx),
          Math.max(fromIdx, toIdx) + 1
      );

      results.push({
        label: fav.label,
        route_short_name: trip.route_short_name,
        route_long_name: trip.route_long_name,
        shape: slicedShape,
        from_stop_id: fav.from_stop_id,
        to_stop_id: fav.to_stop_id,
        route_id: fav.route_id,
        from_stop: fav.from_stop,
        to_stop: fav.to_stop,
      });
    }

    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ POST new favorite route (requires auth)
router.post("/", verifyToken, express.json(), async (req, res) => {
  console.log("Decoded user:", req.user);
  const user_id = req.user.id;
  const { from_stop_id, to_stop_id, route_id, label } = req.body;

  if (!from_stop_id || !to_stop_id || !route_id || !label) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    const db = await getDb();

    // 🚫 Check if route_id exists
    const routeExists = await db.get(
        `SELECT 1 FROM routes WHERE route_id = ?`,
        [route_id]
    );
    if (!routeExists) {
      return res.status(404).json({ error: "Route not found" });
    }

    // 🚫 Check if stops exist
    const fromStop = await db.get(`SELECT * FROM stops WHERE stop_id = ?`, [
      from_stop_id,
    ]);
    const toStop = await db.get(`SELECT * FROM stops WHERE stop_id = ?`, [
      to_stop_id,
    ]);

    if (!fromStop || !toStop) {
      return res.status(404).json({ error: "One or both stops not found" });
    }

    // 🚫 Check if this trip combination is valid for this route
    const validTrip = await db.get(
        `SELECT t.trip_id
       FROM stop_times st1
       JOIN stop_times st2 ON st1.trip_id = st2.trip_id
       JOIN trips t ON t.trip_id = st1.trip_id
       WHERE st1.stop_id = ? AND st2.stop_id = ? 
         AND st1.stop_sequence < st2.stop_sequence
         AND t.route_id = ?
       LIMIT 1`,
        [from_stop_id, to_stop_id, route_id]
    );

    if (!validTrip) {
      return res
          .status(400)
          .json({ error: "Invalid route or stop combination" });
    }

    // 🚫 Already saved?
    const existing = await db.get(
        `SELECT * FROM favorites WHERE user_id = ? AND from_stop_id = ? AND to_stop_id = ? AND route_id = ?`,
        [user_id, from_stop_id, to_stop_id, route_id]
    );

    if (existing) {
      return res.status(409).json({ error: "Favorite already exists" });
    }

    // ✅ Insert favorite
    await db.run(
        `INSERT INTO favorites (user_id, from_stop_id, to_stop_id, route_id, label)
       VALUES (?, ?, ?, ?, ?)`,
        [user_id, from_stop_id, to_stop_id, route_id, label]
    );

    // Fetch the newly created favorite with all details
    const newFavorite = await db.get(
        `SELECT f.*, s1.stop_name AS from_stop, s2.stop_name AS to_stop
       FROM favorites f
       JOIN stops s1 ON s1.stop_id = f.from_stop_id
       JOIN stops s2 ON s2.stop_id = f.to_stop_id
       WHERE f.user_id = ? AND f.from_stop_id = ? AND f.to_stop_id = ? AND f.route_id = ?`,
        [user_id, from_stop_id, to_stop_id, route_id]
    );

    const trip = await db.get(
        `SELECT t.trip_id, t.shape_id, r.route_short_name, r.route_long_name
       FROM trips t
       JOIN routes r ON r.route_id = t.route_id
       JOIN stop_times st1 ON st1.trip_id = t.trip_id
       JOIN stop_times st2 ON st2.trip_id = t.trip_id
       WHERE st1.stop_id = ? AND st2.stop_id = ?
       AND st1.stop_sequence < st2.stop_sequence
       AND t.route_id = ?
       LIMIT 1`,
        [from_stop_id, to_stop_id, route_id]
    );

    let responseData = {
      label,
      from_stop_id,
      to_stop_id,
      route_id,
      from_stop: fromStop.stop_name,
      to_stop: toStop.stop_name,
      shape: [],
    };

    if (trip) {
      const shape = await db.all(
          `SELECT shape_pt_lat AS lat, shape_pt_lon AS lon, shape_pt_sequence
         FROM shapes WHERE shape_id = ? ORDER BY shape_pt_sequence`,
          [trip.shape_id]
      );

      const fromCoords = { lat: fromStop.stop_lat, lon: fromStop.stop_lon };
      const toCoords = { lat: toStop.stop_lat, lon: toStop.stop_lon };

      const haversine = (lat1, lon1, lat2, lon2) => {
        const R = 6371;
        const dLat = ((lat2 - lat1) * Math.PI) / 180;
        const dLon = ((lon2 - lon1) * Math.PI) / 180;
        const a =
            Math.sin(dLat / 2) ** 2 +
            Math.cos((lat1 * Math.PI) / 180) *
            Math.cos((lat2 * Math.PI) / 180) *
            Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      };

      const closestIndex = (list, point) =>
          list.reduce((closestIdx, curr, i, arr) => {
            const dist = haversine(curr.lat, curr.lon, point.lat, point.lon);
            const closestDist = haversine(
                arr[closestIdx].lat,
                arr[closestIdx].lon,
                point.lat,
                point.lon
            );
            return dist < closestDist ? i : closestIdx;
          }, 0);

      const fromIdx = closestIndex(shape, fromCoords);
      const toIdx = closestIndex(shape, toCoords);
      const slicedShape = shape.slice(
          Math.min(fromIdx, toIdx),
          Math.max(fromIdx, toIdx) + 1
      );

      responseData = {
        label,
        route_short_name: trip.route_short_name,
        route_long_name: trip.route_long_name,
        shape: slicedShape,
        from_stop_id,
        to_stop_id,
        route_id,
        from_stop: fromStop.stop_name,
        to_stop: toStop.stop_name,
      };
    }

    res.status(201).json(responseData);
  } catch (err) {
    console.error("❌ Error adding favorite:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ PUT to update label of a favorite (requires auth)
router.put("/", verifyToken, express.json(), async (req, res) => {
  const user_id = req.user.id;
  const { from_stop_id, to_stop_id, route_id, new_label } = req.body;

  if (!from_stop_id || !to_stop_id || !route_id || !new_label) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    const db = await getDb();

    const existing = await db.get(
        `SELECT * FROM favorites 
       WHERE user_id = ? AND from_stop_id = ? AND to_stop_id = ? AND route_id = ?`,
        [user_id, from_stop_id, to_stop_id, route_id]
    );

    if (!existing) {
      return res.status(404).json({ error: "Favorite not found" });
    }

    await db.run(
        `UPDATE favorites 
       SET label = ?
       WHERE user_id = ? AND from_stop_id = ? AND to_stop_id = ? AND route_id = ?`,
        [new_label, user_id, from_stop_id, to_stop_id, route_id]
    );

    res.status(200).json({ message: "Favorite label updated successfully" });
  } catch (err) {
    console.error("❌ Error updating favorite:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ DELETE a favorite route (requires auth)
router.delete("/", verifyToken, async (req, res) => {
  const user_id = req.user.id;
  const { from_stop_id, to_stop_id, route_id } = req.query;

  if (!from_stop_id || !to_stop_id || !route_id) {
    return res.status(400).json({ error: "Missing parameters" });
  }

  try {
    const db = await getDb();

    const result = await db.run(
        `DELETE FROM favorites
       WHERE user_id = ? AND from_stop_id = ? AND to_stop_id = ? AND route_id = ?`,
        [user_id, from_stop_id, to_stop_id, route_id]
    );

    if (result.changes === 0) {
      return res.status(404).json({ message: "Favorite not found" });
    }

    res.status(200).json({ message: "Favorite deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;