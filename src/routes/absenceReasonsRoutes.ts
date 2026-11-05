import { Router } from 'express';
import {
  submitAbsenceReason,
  getAbsenceReasons,
  updateAbsenceReasonStatus,
  deleteAbsenceReason,
} from '../controllers/absenceReasonsController';

const router = Router();

router.get('/',            getAbsenceReasons);
router.post('/',           submitAbsenceReason);
router.patch('/:id/status', updateAbsenceReasonStatus);
router.delete('/:id',      deleteAbsenceReason);

export default router;