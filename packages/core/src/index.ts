// Explicit re-exports: bundlers resolve these reliably across the workspace.

export {
  AppError,
  ERROR_CODES,
  ERRORS,
  isErrorCode,
  publicError,
  SIGN_ON_REFUSALS,
  signOnRefusal,
  type ErrorCode,
  type PublicError,
  type SignOnRefusal,
} from "./errors";

export { holdsUnwritableText } from "./plain-text";

export {
  embedOriginsInputSchema,
  normalizeEmbedOrigins,
  storedEmbedOrigins,
} from "./embed-origins";

export {
  ATTACHMENT_HEAD_BYTES,
  ATTACHMENT_REFUSABLE_KINDS,
  ATTACHMENT_TYPES,
  type AttachmentRefusableKind,
  attachmentIsRefused,
  attachmentPreviewKind,
  isImageAttachmentMime,
  isInlineAttachmentMime,
} from "./attachment-types";

export {
  asPayload,
  auditValue,
  cellFromAudit,
  earlierChanges,
  earlierInputSchema,
  payloadId,
  previewValue,
  REVERT_CATALOG_TABLE,
  REVERT_FIELDS,
  REVERT_KINDS,
  revertCatalogInputSchema,
  revertRowInputSchema,
  sameDocument,
  type EarlierChange,
  type RevertKind,
} from "./revert";

export {
  assertCellValue,
  ATTACHMENT_KEY,
  type CellValue,
  cellValueSchema,
  coerceCellValue,
  formatPlace,
  isColor,
  isEmail,
  isHttpUrl,
  isPlace,
  parseColor,
  parsePlace,
  type Place,
} from "./cell-values";

export { jsonCellText, prettyJson } from "./json-text";
export { sameAsSeen } from "./seen-cell";

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
  TEXT_APPEARANCES,
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
  type TextAppearance,
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

export { FieldGuess, inferFieldType, type InferredField } from "./import-infer";

export {
  ADMIN_LOCK_MINUTES,
  INSTANCE_DEFAULTS,
  PRODUCT_NAME,
  ATTACHMENT_MAX_BYTES_CEILING,
  DEFAULT_ATTACHMENT_MAX_BYTES,
  emailDomainAllowed,
  inactivityDates,
  API_SETTING_KEYS,
  apiSettingsPatchSchema,
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
  MAX_AUTOMATION_SECRETS,
  MAX_LOOP_ROWS,
  MAX_NESTED_ACTIONS,
  MAX_SCRIPT_LENGTH,
  TEMPLATE_KEYS,
  automationActionSchema,
  automationTriggerSchema,
  automationSecretInputSchema,
  createAutomationInputSchema,
  fillSecrets,
  hasScript,
  nextScheduleRun,
  renderTemplate,
  scriptTemplateValues,
  secretNames,
  updateAutomationInputSchema,
  webhookTemplateValues,
  writeSlackMessage,
  writeTeamsMessage,
  type AutomationAction,
  type AutomationSecretInfo,
  type AutomationSecretInput,
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
  DEFAULT_CHANNEL_EVENTS,
  INSTANCE_EVENT_TYPES,
  instanceEventSchema,
  instanceEventText,
  jobEventType,
  type InstanceEvent,
  type InstanceEventFields,
  type InstanceEventType,
} from "./notify/events";
export {
  MAX_INTEGRATIONS,
  NOTIFY_DEDUPE_MS,
  NOTIFY_FAILURE_LIMIT,
  NOTIFY_RATE_MAX,
  NOTIFY_RATE_WINDOW_MS,
  rateDecision,
  type RateDecision,
  type RateState,
} from "./notify/rate";
export {
  NOTIFY_PROVIDERS,
  notifyProvider,
  notifyProviderView,
  parseProviderConfig,
} from "./notify/registry";
export type {
  NotifyFamily,
  NotifyProvider,
  ProviderField,
  ProviderFieldKind,
} from "./notify/provider";
export {
  webhookConfigSchema,
  webhookSecretsSchema,
  type WebhookConfig,
  type WebhookSecrets,
} from "./notify/providers/webhook";
export { ntfyConfigSchema, ntfySecretsSchema } from "./notify/providers/ntfy";
export {
  gotifyConfigSchema,
  gotifySecretsSchema,
} from "./notify/providers/gotify";
export {
  appriseConfigSchema,
  appriseSecretsSchema,
} from "./notify/providers/apprise";
export { smtpChannelConfigSchema } from "./notify/providers/smtp";
export { heartbeatSecretsSchema } from "./notify/providers/heartbeat";
export {
  alertmanagerConfigSchema,
  alertmanagerSecretsSchema,
  incomingUrlSecretsSchema,
  matrixConfigSchema,
  matrixSecretsSchema,
} from "./notify/providers/rooms";
export {
  metricsSecretsSchema,
  otlpConfigSchema,
  otlpSecretsSchema,
  sentryDsnSchema,
  sentrySecretsSchema,
} from "./notify/providers/probes";

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
  resolveCommentInputSchema,
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

export {
  BASE_TEMPLATES,
  findTemplate,
  templateOn,
  type BaseTemplate,
} from "./templates";
export { localizeTemplate } from "./template-words";

export {
  applyViewConfigPatch,
  type FormWindow,
  formWindow,
  formWindowNeverOpens,
  keepTrashedParts,
  MAX_FROZEN_COLUMNS,
  MAX_VIEW_GROUPS,
  MAX_VIEW_SORTS,
  normalizeViewConfig,
  pruneViewConfig,
  stripColumnFromConfig,
  type ViewConfig,
  viewConfigColumns,
  type ViewConfigPatch,
  viewFilter,
  type ViewType,
  withRequiredFormFields,
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
  type SideFieldType,
  type StoredColumn,
} from "./query/external-write";

export {
  buildCreateHome,
  buildDropHome,
  buildDropHomeColumn,
  buildDropHomeTable,
  buildHomeColumn,
  buildHomeColumnExists,
  buildHomeTable,
  homeColumnType,
  homePhysicalName,
  homeSchemaName,
  homeTableName,
  isHomeDialect,
  isHomeSchemaName,
  isHomeTable,
  type HomeColumn,
  type HomeDialect,
} from "./query/home";

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
  copyStoredRow,
  copyTable,
  fitCopyValue,
  SYNC_SCHEMA,
  type CopyColumn,
  type StoredValue,
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
  buildHistogram,
  MAX_HISTOGRAM_BINS,
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
  buildReadCells,
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
  accountExportJobInputSchema,
  progressDue,
  type ExportJobInput,
  type JobKind,
  type JobStatus,
  type AccountExportJobInput,
} from "./jobs";

export {
  MAX_SNAPSHOT_ARCHIVE_BYTES,
  MAX_SNAPSHOT_BYTES,
  MAX_SNAPSHOT_DASHBOARDS,
  MAX_SNAPSHOT_FILES,
  MAX_SNAPSHOT_FOLDERS,
  MAX_SNAPSHOT_LINE_BYTES,
  MAX_SNAPSHOT_ROWS,
  MAX_SNAPSHOT_TABLES,
  MAX_SNAPSHOT_WIDGETS,
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
  snapshotSummary,
  type BaseSnapshot,
  type SnapshotDashboard,
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
  widgetConfigOn,
  widgetDataInputSchema,
  widgetSettings,
  DEFAULT_HISTOGRAM_BINS,
  MAX_CHART_CATEGORIES,
  type ChartOrder,
  type ChartPeriod,
  type ChartType,
  type CreateDashboardInput,
  type MetricFn,
  type UpsertWidgetInput,
  WIDGET_ROW_MAX,
  WIDGET_SIZES,
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
  ACTIVITY_KINDS,
  type ActivityEvent,
  type ActivityKind,
  baseActivityInputSchema,
} from "./activity";
export {
  listRestorePointsInputSchema,
  MAX_RESTORE_POINTS,
  restoreBaseJobInputSchema,
  restorePointIdInputSchema,
  restorePointJobInputSchema,
  type RestorePoint,
} from "./restore-points";
export {
  importWorkbookInputSchema,
  importWorkbookJobInputSchema,
  MAX_WORKBOOK_SHEETS,
} from "./workbook";
export {
  decimalSeries,
  decimalToNumber,
  isDecimalString,
  toDecimalString,
} from "./decimal";

export {
  DEFAULT_COPY_INTERVAL_MINUTES,
  DEFAULT_SOURCE_PORTS,
  SOURCE_ENGINES,
  hostSchema,
  isCopySourceEngine,
  sourceDatabaseField,
  sourceInputSchema,
  sourceUpdateSchema,
  type CopySourceEngine,
  type SourceDatabaseField,
  type SourceEngine,
  type SqlSourceEngine,
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
