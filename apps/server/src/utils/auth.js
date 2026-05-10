import argon2 from "argon2";
import crypto from "node:crypto";

const SESSION_COOKIE_NAME = "siteshare_session";
const SESSION_DURATION_DAYS = 14;

export const cookieName = SESSION_COOKIE_NAME;

export function hashText(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export async function hashPassword(password) {
  return argon2.hash(password);
}

export async function verifyPassword(hash, password) {
  return argon2.verify(hash, password);
}

export function generateSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

export function getSessionExpiry() {
  const expiry = new Date();
  expiry.setDate(expiry.getDate() + SESSION_DURATION_DAYS);
  return expiry;
}

export function buildCookieOptions() {
  const secure = process.env.COOKIE_SECURE === "true";

  return {
    httpOnly: true,
    sameSite: secure ? "none" : "lax",
    secure,
    path: "/",
    expires: getSessionExpiry()
  };
}

export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

export function normalizeName(name) {
  return String(name || "").trim().slice(0, 40);
}

export function sanitizeMessage(content) {
  return String(content || "").trim().slice(0, 2000);
}

export function sanitizeRoomName(name) {
  return String(name || "").trim().slice(0, 60);
}

export function normalizeCode(code) {
  return String(code || "").trim().toUpperCase();
}
