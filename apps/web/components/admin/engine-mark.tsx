/**
 * A mark for each client engine: colour and a short glyph, so the person
 * picks an engine by sight. The shapes are AnyGridDB's own, not a brand's
 * artwork; the name sits next to the mark where space allows.
 */
import type { SourceEngine } from "@anygriddb/core";
import { cn } from "@anygriddb/ui";

export const ENGINE_MARKS: Record<
  SourceEngine,
  { label: string; color: string }
> = {
  postgres: { label: "PostgreSQL", color: "#336791" },
  mysql: { label: "MySQL", color: "#00758f" },
  mariadb: { label: "MariaDB", color: "#c0765a" },
  sqlserver: { label: "SQL Server", color: "#cc2927" },
  oracle: { label: "Oracle", color: "#c74634" },
  mongodb: { label: "MongoDB wire", color: "#00684a" },
  opensearch: { label: "OpenSearch", color: "#005eb8" },
  sqlite: { label: "SQLite", color: "#0f80cc" },
};

/** White glyph drawn on the engine's colour. */
function Glyph({ engine }: { engine: SourceEngine }) {
  switch (engine) {
    case "postgres":
      return (
        <g fill="#fff">
          <ellipse cx="11.5" cy="12" rx="6.2" ry="5.4" />
          <ellipse cx="17.2" cy="11.2" rx="3.2" ry="4.2" />
          <circle cx="9.2" cy="11" r="1.1" fill={ENGINE_MARKS.postgres.color} />
          <path d="M7.2 14.2c-.2 2.4-1.4 4.2-3.2 5.2-.4.2-.2.8.3.6 2.2-.8 3.8-2.6 4.4-5.1z" />
        </g>
      );
    case "mysql":
      return (
        <g fill="#fff">
          <path d="M4.5 13.2c1.8-3.6 5.2-5.4 9.2-5.2 2.6.1 4.6 1.2 5.8 2.6.4.5-.1 1.1-.7.9-1.4-.6-2.9-.8-4.6-.5 2.1 1.1 3.4 2.6 3.6 4.4.1.7-.7 1.1-1.2.6-1.4-1.3-3.4-2-5.8-1.8-2.2.2-4 .9-5.2 2.1-.5.5-1.4.1-1.1-.6z" />
          <path d="M14.2 8.4c.4-1.6 1.6-2.8 3.2-3.2.5-.1.8.5.4.8-1 .8-1.8 1.8-2.2 3-.1.4-.7.3-.8-.1-.2-.2-.4-.4-.6-.5z" />
          <circle cx="8.6" cy="12.2" r="0.85" fill={ENGINE_MARKS.mysql.color} />
        </g>
      );
    case "mariadb":
      return (
        <g fill="#fff">
          <ellipse cx="12" cy="14.5" rx="7" ry="4.2" />
          <circle cx="12" cy="9.2" r="4.2" />
          <circle
            cx="10.4"
            cy="8.6"
            r="0.7"
            fill={ENGINE_MARKS.mariadb.color}
          />
          <circle
            cx="13.6"
            cy="8.6"
            r="0.7"
            fill={ENGINE_MARKS.mariadb.color}
          />
          <path
            d="M8.2 10.2h-2.6M8.4 11.2h-2.4M15.8 10.2h2.6M15.6 11.2h2.4"
            stroke="#fff"
            strokeWidth="0.9"
            strokeLinecap="round"
            fill="none"
          />
        </g>
      );
    case "sqlserver":
      return (
        <g fill="none" stroke="#fff" strokeWidth="1.4">
          <ellipse cx="12" cy="6.8" rx="5.6" ry="2.1" />
          <path d="M6.4 6.8v3.2c0 1.2 2.5 2.1 5.6 2.1s5.6-.9 5.6-2.1V6.8" />
          <path d="M6.4 12.2v3.2c0 1.2 2.5 2.1 5.6 2.1s5.6-.9 5.6-2.1v-3.2" />
          <ellipse cx="12" cy="12.2" rx="5.6" ry="2.1" />
          <ellipse cx="12" cy="17.6" rx="5.6" ry="2.1" />
        </g>
      );
    case "oracle":
      return (
        <g fill="none" stroke="#fff" strokeWidth="2.4">
          <rect x="4.2" y="7.2" width="15.6" height="9.6" rx="4.8" />
        </g>
      );
    case "mongodb":
      // Leaf: a document store, not a brand mark.
      return (
        <g fill="#fff">
          <path d="M12 4.5c2.8 2.2 4.8 5.2 4.8 8.2 0 3.4-2.1 5.8-4.8 6.8-2.7-1-4.8-3.4-4.8-6.8 0-3 2-6 4.8-8.2z" />
          <path
            d="M12 6.2v12.2"
            stroke={ENGINE_MARKS.mongodb.color}
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </g>
      );
    case "opensearch":
      // Concentric arcs: search over an index.
      return (
        <g fill="none" stroke="#fff" strokeWidth="1.6">
          <circle cx="11" cy="11" r="5.2" />
          <circle cx="11" cy="11" r="2.4" />
          <path d="M15.2 15.2l3.6 3.6" strokeLinecap="round" />
        </g>
      );
    case "sqlite":
      // Feather: a light file database.
      return (
        <g fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round">
          <path d="M7 17.5c4-1.5 7.5-5 9.5-9.5 0.6-1.4-.6-2.6-2-2-4.5 2-8 5.5-9.5 9.5" />
          <path d="M8.2 15.2l7.2-7.2" />
          <path d="M9.5 17.8l1.2-3.2" />
        </g>
      );
  }
}

export function EngineMark({
  engine,
  className,
  title,
}: {
  engine: SourceEngine;
  className?: string;
  /** Names the mark for assistive technology; without it, decorative. */
  title?: string;
}) {
  const mark = ENGINE_MARKS[engine];
  return (
    <svg
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("shrink-0", className)}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      <rect width="24" height="24" rx="4" fill={mark.color} />
      <Glyph engine={engine} />
    </svg>
  );
}
