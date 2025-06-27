import express from "express";
import cors from "cors";
import swaggerUI from "swagger-ui-express";
import YAML from "yamljs";
import multer from "multer"; // Añade multer
import routeAPI from "./api/route.js";
import favoritesAPI from "./api/favorites.js";
import usersAPI from "./api/users.js";
import allRoutesAPI from "./api/allRoutes.js";
import routeDetailsAPI from "./api/routeDetails.js";
//This is just a comment from Gabriel
const app = express();
const PORT = 3001;
const swaggerDocument = YAML.load("./swagger.yaml");

const upload = multer({ dest: "uploads/" });

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use("/api/route", routeAPI);
app.use("/api/favorites", favoritesAPI);
app.use("/api/users", upload.single("profilePic"), usersAPI);
app.use("/api/allRoutes", allRoutesAPI);
app.use("/api/routeDetails", routeDetailsAPI);

// Swagger Docs
app.use(
  "/api-docs",
  swaggerUI.serve,
  swaggerUI.setup(swaggerDocument, { explorer: true })
);

// Root route for health check
app.get("/", (req, res) => {
  res.send("🚀 GTFS API server is up and running!");
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
