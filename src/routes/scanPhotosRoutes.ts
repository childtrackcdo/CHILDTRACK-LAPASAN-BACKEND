import { Router } from 'express';
import {
  uploadScanPhoto,
  getScanPhotos,
  deleteScanPhoto,
} from '../controllers/scanPhotoController';
import { authMiddleware } from '../../middleware/authMiddleware';

const router = Router();

router.get('/',       authMiddleware, getScanPhotos);
router.post('/',      authMiddleware, uploadScanPhoto);
router.delete('/:id', authMiddleware, deleteScanPhoto);

export default router;