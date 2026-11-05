import { Request, Response, NextFunction } from "express";

export function notFound(req: Request, res: Response): void {
  res.status(404).json({ error: `Route ${req.method} ${req.originalUrl} not found` });
}

export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const status = err.status ?? err.statusCode ?? 500;
  const message = err.message ?? "Internal Server Error";
  console.error(`[${status}] ${message}`, err.stack ?? "");
  res.status(status).json({ error: message });
}
