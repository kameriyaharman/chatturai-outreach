import express from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export const authRouter = express.Router();

authRouter.post('/login', (req, res) => {
  const { password } = req.body || {};
  if (!password || password !== config.appPassword) {
    return res.status(401).json({ error: 'Wrong password.' });
  }
  const token = jwt.sign({ ok: true }, config.jwtSecret, { expiresIn: '30d' });
  res.cookie('session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 3600 * 1000,
  });
  res.json({ ok: true });
});

authRouter.post('/logout', (req, res) => {
  res.clearCookie('session');
  res.json({ ok: true });
});

authRouter.get('/me', (req, res) => {
  const token = req.cookies?.session;
  try {
    jwt.verify(token, config.jwtSecret);
    res.json({ authenticated: true });
  } catch {
    res.json({ authenticated: false });
  }
});

export function requireAuth(req, res, next) {
  try {
    jwt.verify(req.cookies?.session, config.jwtSecret);
    next();
  } catch {
    res.status(401).json({ error: 'Not signed in.' });
  }
}
