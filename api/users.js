import express from "express";
import { getDb } from "../db/connection.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config(); // Load .env variables

const router = express.Router();

// Register new user
router.post("/register", async (req, res) => {
  const { email, password, first_name, last_name } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Missing email or password" });
  }

  try {
    const db = await getDb();
    const existing = await db.get(`SELECT * FROM users WHERE email = ?`, [
      email,
    ]);

    if (existing) {
      return res.status(409).json({ error: "User already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await db.run(
      `INSERT INTO users (email, password, first_name, last_name) VALUES (?, ?, ?, ?)`,
      [email, hashedPassword, first_name, last_name]
    );

    res.status(201).json({ message: "User registered successfully" });
  } catch (err) {
    console.error("❌ Error registering user:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Login and return JWT
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Missing email or password" });
  }

  try {
    const db = await getDb();
    const user = await db.get(`SELECT * FROM users WHERE email = ?`, [email]);

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return res.status(401).json({ error: "Invalid password" });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    const { password: _, ...userInfo } = user;

    res.status(200).json({ ...userInfo, token });
  } catch (err) {
    console.error("Error logging in:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
