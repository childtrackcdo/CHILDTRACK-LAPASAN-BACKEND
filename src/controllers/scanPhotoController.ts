import { Response } from 'express';
import pool from '../../lib/db';
import { AuthRequest } from '../../middleware/authMiddleware';
import cloudinary from '../../config/cloudinary';

// ─── Helper: upload base64 to Cloudinary ─────────────────────────────────────
async function uploadToCloudinary(base64: string, studentName: string): Promise<string> {
  const result = await cloudinary.uploader.upload(base64, {
    folder:         'childtrack-hs/scans',
    public_id:      `scan_${Date.now()}_${studentName.replace(/\s+/g, '_')}`,
    transformation: [
      { width: 800, height: 800, crop: 'limit' as const },
      { quality: 'auto' },
    ],
  });
  return result.secure_url;
}

// ─── POST /api/scan-photos ────────────────────────────────────────────────────
export async function uploadScanPhoto(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { student_name, status, photo_base64 } = req.body;

    if (!photo_base64 || !student_name) {
      res.status(400).json({ error: 'student_name and photo_base64 are required' });
      return;
    }

    const photoUrl = await uploadToCloudinary(photo_base64, student_name);

    await pool.execute(
      'INSERT INTO scan_photos (student_name, status, photo_path) VALUES (?,?,?)',
      [student_name, status || null, photoUrl],
    );

    res.status(201).json({ message: 'Photo saved', path: photoUrl });
  } catch (err: any) {
    console.error('uploadScanPhoto error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── GET /api/scan-photos ─────────────────────────────────────────────────────
export async function getScanPhotos(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { student_name, limit } = req.query as Record<string, string>;
    const maxLimit = Math.min(Number(limit) || 100, 500);

    let sql    = 'SELECT * FROM scan_photos';
    const params: any[] = [];

    if (student_name) {
      sql += ' WHERE student_name LIKE ?';
      params.push(`%${student_name}%`);
    }

    sql += ` ORDER BY captured_at DESC LIMIT ${maxLimit}`;

    const [rows] = await pool.execute(sql, params) as any[];

    const normalized = (rows as any[]).map(row => ({
      ...row,
      photo_path: row.photo_path?.startsWith('http') ? row.photo_path : null,
    }));

    res.json(normalized);
  } catch (err: any) {
    console.error('getScanPhotos error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── DELETE /api/scan-photos/:id ─────────────────────────────────────────────
export async function deleteScanPhoto(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    const [rows] = await pool.execute(
      'SELECT photo_path FROM scan_photos WHERE id = ?',
      [id],
    ) as any[];

    if (!(rows as any[]).length) {
      res.status(404).json({ error: 'Photo not found' });
      return;
    }

    // Optionally delete from Cloudinary
    const photoPath = (rows as any[])[0].photo_path as string;
    if (photoPath?.startsWith('http')) {
      const publicIdMatch = photoPath.match(/childtrack-hs\/scans\/[^.]+/);
      if (publicIdMatch) {
        await cloudinary.uploader.destroy(publicIdMatch[0]).catch(console.error);
      }
    }

    await pool.execute('DELETE FROM scan_photos WHERE id = ?', [id]);

    res.json({ message: 'Photo deleted successfully' });
  } catch (err: any) {
    console.error('deleteScanPhoto error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}