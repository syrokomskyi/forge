/*
<MODULE_CONTRACT>
<purpose>Expose forge Werkstatt kernel commands through a stable package subpath.</purpose>
<non-goals>
  <item>Do not implement werkstatt handler logic.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0374: initial werkstatt module barrel.</item>
</CHANGE_SUMMARY>
*/

export { forgeWerkstattModule } from "./werkstatt.module.ts";
export {
  werkstattLockSchema,
  werkstattOperationRecordSchema,
  type WerkstattLock,
  type WerkstattOperationRecord,
} from "./handlers/schema.ts";
export {
  acquireLock,
  releaseLock,
  heartbeatLock,
  readAllLocks,
  isLockStale,
  removeStaleLock,
} from "./handlers/lock.ts";
export {
  runWerkstattLockStatus,
  type WerkstattLockStatusData,
} from "./handlers/werkstatt-lock-status.ts";
export {
  runWerkstattLockRecover,
  type WerkstattLockRecoverData,
} from "./handlers/werkstatt-lock-recover.ts";
export {
  runWerkstattOperationValidate,
  type WerkstattOperationValidateData,
} from "./handlers/werkstatt-operation-validate.ts";
