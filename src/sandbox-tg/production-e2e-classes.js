// Compatibility exports for Durable Object classes created by an applied
// migration. No active Worker environment binds these classes.
import { IntakeBuffer } from '../intake-buffer.js';
import { TgDeliveryOwner } from './delivery-owner.js';

export class ProductionE2eIntakeBuffer extends IntakeBuffer {}
export class ProductionE2eTgDeliveryOwner extends TgDeliveryOwner {}
