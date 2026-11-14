// Explicit re-exports: bundlers resolve these reliably across the workspace.

export {
  AppError,
  ERROR_CODES,
  ERRORS,
  isErrorCode,
  publicError,
  type ErrorCode,
  type PublicError,
} from "./errors";

export {
  embedOriginsInputSchema,
  normalizeEmbedOrigins,
  storedEmbedOrigins,
} from "./embed-origins";

export {
  ATTACHMENT_TYPES,
  attachmentPreviewKind,
  isImageAttachmentMime,
  isInlineAttachmentMime,
} from "./attachment-types";

export {
  ATTACHMENT_KEY,
  assertCellValue,
  cellValueSchema,
  coerceCellValue,
  isEmail,
  isHttpUrl,
  type CellValue,
} from "./cell-values";

export {
  cellText,
  DelimitedReader,
  detectDelimiter,
  parseDelimited,
  toCsv,
  toCsvRows,
} from "./csv";

export {
  type ButtonConfig,
  BOOLEAN_APPEARANCES,
  MULTI_SELECT_APPEARANCES,
  OPTION_COLORS,
  RATING_ICONS,
  ROLLUP_FNS,
  SINGLE_SELECT_APPEARANCES,
  isTimeZone,
  parseColumnConfig,
  rollupFitsTarget,
  selectOptionNames,
  type BooleanAppearance,
  type ColumnConfig,
  type LinkSelection,
  type DateFormat,
  type MultiSelectAppearance,
  type OptionColor,
  type RollupFn,
  type SelectOption,
  type SingleSelectAppearance,
} from "./field-config";

export {
  PRIMARY_TYPES,
  WRITABLE_TYPES,
  hasPhysicalColumn,
  isComputedType,
  isPrimaryType,
  isRelationType,
  isWritableType,
  canBeRequired,
  type FieldType,
} from "./field-types";

export {
  DATE_MODES,
  MAX_FILTER_CONDITIONS,
  MAX_FILTER_DEPTH,
  WITHIN_MODES,
  andFilters,
  filterGroupSchema,
  filterOperatorsFor,
  isFilterGroup,
  legacyFiltersToGroup,
  type FilterCondition,
  type FilterGroup,
  type FilterKind,
  type FilterOperator,
  type FilterValue,
} from "./filter";

export {
  checkFormulaTyped,
  type FormulaTypeColumn,
  type FormulaTypeContext,
  typeFormula,
} from "./formula-type";

export {
  checkFormula,
  formatFormula,
  FORMULA_FNS,
  type FormulaExpr,
  type FormulaFn,
  type FormulaRef,
  formulaReferences,
  formulaTokens,
  parseFormula,
} from "./formula";

export { inferFieldType, type InferredField } from "./import-infer";

export {
  ADMIN_LOCK_MINUTES,
  INSTANCE_DEFAULTS,
  PRODUCT_NAME,
  ATTACHMENT_MAX_BYTES_CEILING,
  DEFAULT_ATTACHMENT_MAX_BYTES,
  emailDomainAllowed,
  inactivityDates,
  instanceSettingsPatchSchema,
  fillMapTileUrl,
  lockState,
  mapTileOrigin,
  memberDomainAllowed,
  parseAdminEmails,
  parseInstanceSettings,
  resolveAttachmentMaxBytes,
  sessionWindows,
  signupAllowed,
  type InstanceSettings,
  type InstanceSettingsPatch,
} from "./instance";

export {
  INSTANCE_LOGO_MAX_BYTES,
  INSTANCE_LOGO_TYPES,
  instanceLogoInputSchema,
  instanceLogoType,
} from "./instance-logo";

export { acceptedLocale, madeNames, type MadeNames } from "./made-names";

export {
  MAX_AUTOMATION_ACTIONS,
  MAX_LOOP_ROWS,
  MAX_NESTED_ACTIONS,
  TEMPLATE_KEYS,
  automationActionSchema,
  automationTriggerSchema,
  createAutomationInputSchema,
  nextScheduleRun,
  renderTemplate,
  updateAutomationInputSchema,
  webhookTemplateValues,
  type AutomationAction,
  type AutomationStep,
  type AutomationTrigger,
} from "./automation";

export { mentionMarkup, mentionSegments, parseMentions } from "./mentions";

export {
  MAX_EVENT_DEPTH,
  WEBHOOK_FAILURE_LIMIT,
  nextRetryDelay,
  rowEventSchema,
  touchesWatched,
  type RowEvent,
} from "./events";

export {
  columnNameSchema,
  deriveColumnName,
  isReservedColumnName,
  labelSchema,
} from "./names";

export {
  ROLES,
  can,
  effectiveTableRole,
  enrollmentGate,
  roleAllows,
  roleFor,
  roleRank,
  type Action,
  type Binding,
  type Role,
} from "./rbac";

export {
  CREATABLE_TYPES,
  addColumnInputSchema,
  addCommentInputSchema,
  addLookupInputSchema,
  addRelationInputSchema,
  addRollupInputSchema,
  assertStatusTransition,
  auditReadInputSchema,
  tableActivityInputSchema,
  columnFromAddInput,
  createApiTokenInputSchema,
  createBaseInputSchema,
  createTableInputSchema,
  createViewInputSchema,
  createWebhookInputSchema,
  deleteBaseInputSchema,
  deleteColumnInputSchema,
  deleteCommentInputSchema,
  deleteRowsInputSchema,
  deleteTableInputSchema,
  deleteViewInputSchema,
  deleteWebhookInputSchema,
  duplicateColumnInputSchema,
  duplicateTableInputSchema,
  duplicateViewInputSchema,
  EXPORT_FORMATS,
  IMPORT_FORMATS,
  importCommitInputSchema,
  insertRowInputSchema,
  insertRowsInputSchema,
  moveRowsInputSchema,
  linkCandidatesInputSchema,
  listCommentsInputSchema,
  listViewsInputSchema,
  listWebhooksInputSchema,
  previewConversionInputSchema,
  reorderColumnsInputSchema,
  reorderTablesInputSchema,
  reorderViewsInputSchema,
  resolveChangeReason,
  assertRequiredValues,
  isBlankCell,
  restoreRowsInputSchema,
  revokeApiTokenInputSchema,
  rowIdSchema,
  rowsAggregateInputSchema,
  rowsGetInputSchema,
  rowsReadInputSchema,
  setLinksInputSchema,
  setPrimaryColumnInputSchema,
  setStatusInputSchema,
  signRowInputSchema,
  trashInputSchema,
  updateBaseInputSchema,
  updateColumnInputSchema,
  updateCommentInputSchema,
  updateRowsInputSchema,
  updateTableInputSchema,
  updateViewInputSchema,
  updateWebhookInputSchema,
  retryDeliveryInputSchema,
  webhookDeliveriesInputSchema,
  webhookIdInputSchema,
  type AuditRole,
  type ColumnDefinition,
  type ExportFormat,
  type ImportCommitInput,
  type ImportFormat,
} from "./schemas";

export { BASE_TEMPLATES, findTemplate, type BaseTemplate } from "./templates";
export { localizeTemplate } from "./template-words";

export {
  MAX_FROZEN_COLUMNS,
  MAX_VIEW_GROUPS,
  MAX_VIEW_SORTS,
  applyViewConfigPatch,
  normalizeViewConfig,
  withRequiredFormFields,
  keepTrashedParts,
  pruneViewConfig,
  stripColumnFromConfig,
  viewConfigColumns,
  viewFilter,
  type ViewConfig,
  type ViewConfigPatch,
  type ViewType,
} from "./view-config";

export { evaluateFilter, type FilterEvalContext } from "./filter-eval";

export { misplacedConditionFields, visibleFormFields } from "./form-visibility";

export {
  buildICalendar,
  type CalendarEvent,
  type CalendarMoment,
} from "./ical";

export {
  airtableToSnapshot,
  type AirtableNote,
  type AirtableRecord,
  type AirtableTable,
} from "./airtable";

export {
  buildAddColumn,
  buildAddForeignKeyColumn,
  buildConversionPreview,
  buildConversionStatements,
  buildCreateJunction,
  buildCreateTable,
  buildDropColumn,
  buildDropTable,
  buildDropUniqueIndex,
  buildForeignKeyIndex,
  buildSetDefault,
  buildUniqueIndex,
  indexName,
  isConvertible,
  isMetadataConversion,
} from "./query/ddl";

export {
  type EngineAccess,
  type EngineCatalog,
  type EngineColumn,
  type EngineRelation,
  type EngineTable,
  type ExternalRelation,
} from "./query/engine";

export { parseServerVersion, type DialectName } from "./query/dialect";

export {
  buildExternalDelete,
  buildExternalInsert,
  buildExternalLock,
  buildExternalUpdate,
  buildSideColumn,
  buildSideDelete,
  buildSideEnsure,
  buildSideLock,
  buildSideTable,
  buildSideUpsert,
  isSideFieldType,
  SIDE_FIELD_TYPES,
  sideColumnType,
  buildInsertedId,
  keyValues,
  sameCell,
  type ExternalValue,
  type StoredColumn,
} from "./query/external-write";

export {
  buildDuplicateJunction,
  buildDuplicateRows,
  buildDuplicateSelfLinks,
  buildSequenceAfter,
  DUPLICATE_CHUNK,
} from "./query/duplicate";
export {
  buildPositionsAfter,
  buildRowSeqs,
  buildSnapshotForeignKeys,
  buildSnapshotJunction,
  buildSnapshotKeys,
  MAX_SNAPSHOT_LINK_PAIRS,
} from "./query/snapshot-rows";

export {
  ALERT_CHOICES,
  alertMailDue,
  dueAlerts,
  type AlertChoice,
  type AlertFacts,
  type AlertKind,
  type DueAlert,
} from "./alerts";

export {
  buildCopyCreate,
  buildCopyDiff,
  buildCopyDrop,
  buildCopyInsert,
  buildCopySwap,
  buildCopyUpsert,
  copyColumns,
  copyRow,
  copyTable,
  SYNC_SCHEMA,
  type CopyColumn,
} from "./query/sync";

export { sealDrift, sealedFields, sealRow, sealText } from "./query/seal";

export {
  buildChangeTracking,
  buildChangeVersion,
  buildWatchPage,
  buildWatchStart,
  buildWatchWindow,
  watchKind,
  type WatchColumn,
} from "./query/watch";

export {
  formulaLimits,
  limitKey,
  limitOf,
  type SourceLimit,
} from "./query/limits";
export { quoteIdent, type ParameterizedSql } from "./query/params";

export {
  MAX_GROUPS,
  MAX_READ_LIMIT,
  aggregateFunctionsFor,
  buildAggregates,
  buildGroupAggregates,
  buildCountRows,
  buildGroupCounts,
  buildReadRows,
  ROW_ERRORS,
  rowError,
  describeColumns,
  type AggregateFn,
  type AggregateItem,
  type ReadSpec,
  type RowSort,
} from "./query/read";

export {
  buildClearLinks,
  buildCountDuplicates,
  buildCountLocked,
  buildDelete,
  buildDistinctText,
  buildExistingIds,
  buildInsert,
  buildInsertLinks,
  buildInserts,
  buildNonNullValues,
  buildReadJunction,
  buildReadReferencing,
  buildReadStatus,
  buildReadStatuses,
  buildRenameOption,
  buildRestoreRow,
  buildSetLink,
  buildSetStatus,
  buildUpdate,
  type WriteColumn,
} from "./query/write";

export {
  buildMoveRows,
  buildOrderLock,
  buildRowPlaces,
  placeTarget,
  type RowPlace,
} from "./query/row-order";

export {
  EXPORT_FILE_HOURS,
  JOB_HEARTBEAT_MS,
  JOB_KINDS,
  JOB_LEASE_MS,
  JOB_RETENTION_DAYS,
  JOB_STATUSES,
  MAX_ACTIVE_JOBS,
  airtableBaseId,
  duplicateJobInputSchema,
  importAirtableJobInputSchema,
  startAirtableImportInputSchema,
  exportJobInputSchema,
  importJobInputSchema,
  jobIdInputSchema,
  jobInputSchemas,
  listJobsInputSchema,
  progressDue,
  type ExportJobInput,
  type JobKind,
  type JobStatus,
} from "./jobs";

export {
  MAX_SNAPSHOT_ARCHIVE_BYTES,
  MAX_SNAPSHOT_BYTES,
  MAX_SNAPSHOT_FILES,
  MAX_SNAPSHOT_LINE_BYTES,
  MAX_SNAPSHOT_ROWS,
  MAX_SNAPSHOT_TABLES,
  SNAPSHOT_ENTRY,
  SNAPSHOT_KIND,
  SNAPSHOT_VERSION,
  baseSnapshotSchema,
  exportSnapshotJobInputSchema,
  importSnapshotJobInputSchema,
  snapshotFileRefSchema,
  duplicateBaseInputSchema,
  duplicateBaseJobInputSchema,
  snapshotFilename,
  snapshotLineSchema,
  snapshotRowCount,
  snapshotRowsEntry,
  type BaseSnapshot,
  type SnapshotFile,
  type SnapshotFileRef,
  type SnapshotLine,
  type SnapshotLink,
  type SnapshotTable,
} from "./snapshot";

export {
  clearTableAclInputSchema,
  getTableAclInputSchema,
  setTableAclInputSchema,
  viewAsInputSchema,
  type ColumnAccess,
  type ColumnAclEntry,
  type TableAcl,
} from "./acl";

export {
  createDashboardInputSchema,
  dashboardWidgetConfigSchema,
  deleteDashboardInputSchema,
  deleteWidgetInputSchema,
  getDashboardInputSchema,
  layoutWidgetsInputSchema,
  listDashboardsInputSchema,
  updateDashboardInputSchema,
  upsertWidgetInputSchema,
  widgetDataInputSchema,
  type ChartType,
  type CreateDashboardInput,
  type UpsertWidgetInput,
} from "./dashboards";

export {
  purgeCutoff,
  purgeDate,
  purgeTrashInputSchema,
  restoreInputSchema,
  restoredName,
  trashListInputSchema,
  trashPurgeJobInputSchema,
  type TrashItem,
} from "./trash";
export {
  decimalSeries,
  decimalToNumber,
  isDecimalString,
  toDecimalString,
} from "./decimal";

export {
  DEFAULT_SOURCE_PORTS,
  sourceInputSchema,
  sourceUpdateSchema,
  type SourceEngine,
  type SourceInput,
  type SourceUpdate,
} from "./sources";

export {
  checkChoices,
  mapMysqlType,
  mapPostgresType,
  mapOracleType,
  mapSqlServerType,
  withChoices,
  type MappedField,
} from "./source-types";
export {
  parseScimFilter,
  parseScimGroup,
  parseScimPatch,
  parseScimUser,
  patchScimGroup,
  patchScimUser,
  ScimError,
  scimErrorBody,
  type ScimFilter,
  scimGroupResource,
  type ScimGroupState,
  scimList,
  scimPage,
  type ScimPatchOperation,
  scimResourceTypes,
  scimSchemas,
  scimServiceProviderConfig,
  scimUserResource,
  type ScimUserState,
} from "./scim";

export {
  PEOPLE_FILE_MAX,
  PEOPLE_FILE_MAX_BYTES,
  PEOPLE_FILE_SAMPLE,
  readPeopleFile,
  type PeopleFileProblem,
} from "./people-file";
