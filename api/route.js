import express from "express";
import { getDb } from "../db/connection.js";
import fetch from "node-fetch";
import { MinPriorityQueue } from "@datastructures-js/priority-queue";

const router = express.Router();
const GOOGLE_MAPS_API_KEY = "AIzaSyCDYh8FF5XE4rIJyzzLZKl-WyfzwRhRytw";

// Haversine distance function (km)
const haversine = (lat1, lon1, lat2, lon2) => {
  const R = 6371; // Earth's radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

// Find closest point in a list of coordinates
const closestIndex = (list, point) => {
  if (!list || list.length === 0) return -1;
  return list.reduce((closestIdx, curr, i, arr) => {
    const dist = haversine(curr.lat, curr.lon, point.lat, point.lon);
    const closestDist = haversine(arr[closestIdx].lat, arr[closestIdx].lon, point.lat, point.lon);
    return dist < closestDist ? i : closestIdx;
  }, 0);
};

router.get("/", async (req, res) => {
  const { from, to, userLat, userLon } = req.query;

  // Validar parámetros requeridos
  if (!from || !to) {
    return res.status(400).json({ error: "Missing 'from' or 'to' parameter" });
  }

  try {
    const db = await getDb();

    // Normalizar parámetros
    const normalizedFrom = from.trim().toLowerCase();
    const normalizedTo = to.trim().toLowerCase();

    // Fetch stops matching the query
    const stops = await db.all(
        `SELECT stop_id, stop_name, stop_lat AS lat, stop_lon AS lon 
       FROM stops 
       WHERE lower(stop_name) LIKE ? OR lower(stop_name) LIKE ?
       ORDER BY stop_name`,
        [`%${normalizedFrom}%`, `%${normalizedTo}%`]
    );

    // Filtrar paradas
    const fromStops = stops.filter((s) => s.stop_name.toLowerCase().includes(normalizedFrom));
    const toStops = stops.filter((s) => s.stop_name.toLowerCase().includes(normalizedTo));

    // Validar paradas encontradas
    if (fromStops.length === 0 || toStops.length === 0) {
      return res.status(404).json({
        error: `No matching stops found for ${fromStops.length === 0 ? "origin" : ""}${
            fromStops.length === 0 && toStops.length === 0 ? " and " : ""
        }${toStops.length === 0 ? "destination" : ""}`,
      });
    }

    // Limitar combinaciones para optimizar
    const maxCombinations = 3; // Máximo 3 paradas por origen/destino
    const limitedFromStops = fromStops.slice(0, maxCombinations);
    const limitedToStops = toStops.slice(0, maxCombinations);

    // Build graph for Dijkstra
    const graph = {};
    const allStopIds = new Set(stops.map((s) => s.stop_id));
    const stopCoords = {};
    stops.forEach((s) => (stopCoords[s.stop_id] = { lat: s.lat, lon: s.lon }));

    // Fetch all trips connecting stops
    const tripConnections = await db.all(
        `SELECT st1.stop_id AS from_stop_id, st2.stop_id AS to_stop_id, 
              t.trip_id, t.shape_id, r.route_id, r.route_short_name, r.route_long_name,
              st1.stop_sequence AS from_seq, st2.stop_sequence AS to_seq
       FROM stop_times st1
       JOIN stop_times st2 ON st1.trip_id = st2.trip_id
       JOIN trips t ON t.trip_id = st1.trip_id
       JOIN routes r ON r.route_id = t.route_id
       WHERE st1.stop_id IN (${stops.map(() => "?").join(",")}) 
       AND st2.stop_id IN (${stops.map(() => "?").join(",")}) 
       AND st1.stop_sequence < st2.stop_sequence`,
        [...stops.map((s) => s.stop_id), ...stops.map((s) => s.stop_id)]
    );

    // Build graph edges for bus trips
    tripConnections.forEach(
        ({ from_stop_id, to_stop_id, trip_id, shape_id, route_id, route_short_name, route_long_name, from_seq, to_seq }) => {
          if (!graph[from_stop_id]) graph[from_stop_id] = [];
          const weight = haversine(
              stopCoords[from_stop_id].lat,
              stopCoords[from_stop_id].lon,
              stopCoords[to_stop_id].lat,
              stopCoords[to_stop_id].lon
          );
          graph[from_stop_id].push({
            to: to_stop_id,
            trip_id,
            shape_id,
            route: { route_id, route_short_name, route_long_name },
            from_seq,
            to_seq,
            weight: weight * 0.1, // Escalar peso para priorizar autobuses
          });
        }
    );

    // Add transfer edges (walking between nearby stops)
    const MAX_WALKING_DISTANCE = 0.8; // Max 800m for transfers
    stops.forEach((s1) => {
      stops.forEach((s2) => {
        if (s1.stop_id !== s2.stop_id) {
          const dist = haversine(s1.lat, s1.lon, s2.lat, s2.lon);
          if (dist <= MAX_WALKING_DISTANCE) {
            if (!graph[s1.stop_id]) graph[s1.stop_id] = [];
            graph[s1.stop_id].push({
              to: s2.stop_id,
              trip_id: null,
              shape_id: null,
              route: null,
              from_seq: null,
              to_seq: null,
              weight: dist + 1.5, // Penalizar caminatas
            });
          }
        }
      });
    });

    // Dijkstra's algorithm to find shortest path
    const dijkstra = (start, end) => {
      const distances = {};
      const predecessors = {};
      const routes = {};
      const pq = new MinPriorityQueue((x) => x.dist); // Corregir inicialización

      allStopIds.forEach((id) => {
        distances[id] = Infinity;
        predecessors[id] = null;
        routes[id] = null;
      });
      distances[start] = 0;
      pq.enqueue({ stop: start, dist: 0 });

      while (!pq.isEmpty()) {
        const { stop: current, dist: currentDist } = pq.dequeue(); // Eliminar .element
        if (current === end) break;
        if (currentDist > distances[current]) continue;

        (graph[current] || []).forEach(({ to, weight, trip_id, shape_id, route, from_seq, to_seq }) => {
          const newDist = distances[current] + weight;
          if (newDist < distances[to]) {
            distances[to] = newDist;
            predecessors[to] = current;
            routes[to] = { trip_id, shape_id, route, from_seq, to_seq };
            pq.enqueue({ stop: to, dist: newDist });
          }
        });
      }

      // Reconstruct path
      if (distances[end] === Infinity) return []; // No path found
      const path = [];
      let current = end;
      while (current) {
        if (routes[current]) {
          path.unshift({
            stop_id: current,
            trip_id: routes[current].trip_id,
            shape_id: routes[current].shape_id,
            route: routes[current].route,
            from_seq: routes[current].from_seq,
            to_seq: routes[current].to_seq,
          });
        } else {
          path.unshift({ stop_id: current });
        }
        current = predecessors[current];
      }
      return path;
    };

    // Find best routes
    let results = [];
    for (const fromStop of limitedFromStops) {
      for (const toStop of limitedToStops) {
        const path = dijkstra(fromStop.stop_id, toStop.stop_id);
        if (path.length < 2) continue;

        // Process each segment of the path
        const segments = [];
        let currentTrip = null;
        let segment = { stops: [], shape: [], route: null };

        for (let i = 1; i < path.length; i++) {
          const { stop_id, trip_id, shape_id, route, from_seq, to_seq } = path[i];
          const prevStop = path[i - 1].stop_id;

          const stopInfo = stops.find((s) => s.stop_id === stop_id);
          const prevStopInfo = stops.find((s) => s.stop_id === prevStop);

          if (!stopInfo || !prevStopInfo) continue;

          if (trip_id && trip_id === currentTrip) {
            // Continue same trip
            segment.stops.push({ stop_id: stopInfo.stop_id, stop_name: stopInfo.stop_name, lat: stopInfo.lat, lon: stopInfo.lon });
            if (shape_id && i === path.length - 1) {
              const shape = await db.all(
                  `SELECT shape_pt_lat AS lat, shape_pt_lon AS lon, shape_pt_sequence
                 FROM shapes WHERE shape_id = ? ORDER BY shape_pt_sequence`,
                  [shape_id]
              );
              if (shape.length > 0) {
                const fromIdx = closestIndex(shape, prevStopInfo);
                const toIdx = closestIndex(shape, stopInfo);
                segment.shape = shape.slice(Math.min(fromIdx, toIdx), Math.max(fromIdx, toIdx) + 1);
              }
            }
          } else {
            // New trip or transfer
            if (segment.stops.length > 0) segments.push(segment);
            segment = {
              stops: [{ stop_id: prevStopInfo.stop_id, stop_name: prevStopInfo.stop_name, lat: prevStopInfo.lat, lon: prevStopInfo.lon }],
              shape: [],
              route: route,
            };
            if (trip_id) {
              // Bus segment
              currentTrip = trip_id;
              segment.stops.push({ stop_id: stopInfo.stop_id, stop_name: stopInfo.stop_name, lat: stopInfo.lat, lon: stopInfo.lon });
              if (shape_id) {
                const shape = await db.all(
                    `SELECT shape_pt_lat AS lat, shape_pt_lon AS lon, shape_pt_sequence
                   FROM shapes WHERE shape_id = ? ORDER BY shape_pt_sequence`,
                    [shape_id]
                );
                if (shape.length > 0) {
                  const fromIdx = closestIndex(shape, prevStopInfo);
                  const toIdx = closestIndex(shape, stopInfo);
                  segment.shape = shape.slice(Math.min(fromIdx, toIdx), Math.max(fromIdx, toIdx) + 1);
                }
              }
            } else {
              // Walking transfer
              currentTrip = null;
              segment.stops.push({ stop_id: stopInfo.stop_id, stop_name: stopInfo.stop_name, lat: stopInfo.lat, lon: stopInfo.lon });
              segment.shape = [
                { lat: prevStopInfo.lat, lon: prevStopInfo.lon },
                { lat: stopInfo.lat, lon: stopInfo.lon },
              ];
            }
          }
        }
        if (segment.stops.length > 0) segments.push(segment);

        // Add walking directions if user location is provided
        let walkingDirections = null;
        if (userLat && userLon && GOOGLE_MAPS_API_KEY) {
          const fromCoords = stopCoords[fromStop.stop_id];
          const directionsUrl = `https://maps.googleapis.com/maps/api/directions/json?origin=${userLat},${userLon}&destination=${fromCoords.lat},${fromCoords.lon}&mode=walking&key=${GOOGLE_MAPS_API_KEY}`;

          try {
            const response = await fetch(directionsUrl);
            if (!response.ok) {
              throw new Error(`Google Maps API error: ${response.status}`);
            }
            const data = await response.json();
            if (data.status === "OK" && data.routes.length > 0) {
              const route = data.routes[0];
              walkingDirections = {
                distance: route.legs[0].distance.text,
                duration: route.legs[0].duration.text,
                steps: route.legs[0].steps.map((step) => ({
                  instruction: step.html_instructions,
                  distance: step.distance.text,
                  duration: step.duration.text,
                  polyline: step.polyline.points,
                })),
                polyline: route.overview_polyline.points,
              };
            } else {
              console.warn("Google Maps API: No routes found or invalid response", data.status);
            }
          } catch (err) {
            console.error("Google Maps API error:", err.message);
          }
        }

        // Calculate total transfers and distance
        const totalTransfers = segments.filter((s) => s.route).length - 1;
        const totalDistance = segments.reduce((sum, s) => {
          if (s.shape.length > 1) {
            for (let i = 1; i < s.shape.length; i++) {
              sum += haversine(s.shape[i - 1].lat, s.shape[i - 1].lon, s.shape[i].lat, s.shape[i].lon);
            }
          }
          return sum;
        }, 0);

        results.push({
          from_stop: fromStop.stop_name,
          to_stop: toStop.stop_name,
          from_stop_id: fromStop.stop_id,
          to_stop_id: toStop.stop_id,
          segments,
          walkingDirections,
          totalTransfers: totalTransfers >= 0 ? totalTransfers : 0,
          totalDistance: parseFloat(totalDistance.toFixed(2)),
        });
      }
    }

    // Sort results by totalTransfers, then totalDistance
    results.sort((a, b) => a.totalTransfers - b.totalTransfers || a.totalDistance - b.totalDistance);

    // Limit results to top 5
    results = results.slice(0, 5);

    if (!results.length) {
      return res.status(404).json({ error: "No routes found between the specified stops" });
    }

    res.json(results);
  } catch (error) {
    console.error("Error in route endpoint:", error.message);
    res.status(500).json({ error: `Failed to fetch routes: ${error.message}` });
  }
});

export default router;