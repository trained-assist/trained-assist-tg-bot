import { IntakeBuffer } from '../intake-buffer.js';
import { TgDeliveryOwner } from './delivery-owner.js';

// Separate production test lane state from the existing production bot's DOs.
export class ProductionE2eIntakeBuffer extends IntakeBuffer {}
export class ProductionE2eTgDeliveryOwner extends TgDeliveryOwner {}
