import { uuidv7 } from 'uuidv7';

export function requestLogger(sql) {
  return async (req, res, next) => {
    const start = Date.now();

    res.on('finish', async () => {
      try {
        await sql`
          INSERT INTO request_logs (id, user_id, method, path, status_code, duration_ms, ip, created_at)
          VALUES (
            ${uuidv7()},
            ${req.user?.id ?? null},
            ${req.method},
            ${req.path},
            ${res.statusCode},
            ${Date.now() - start},
            ${req.ip},
            ${new Date().toISOString()}
          )
        `;
      } catch (_) {
        // never let logging errors affect the response
      }
    });

    next();
  };
}
