import type { ColumnDefinition } from "./schemas";

/**
 * Built-in base templates. Labels are English, the interface's source
 * language, and are written in the asker's language when a base is made
 * from one (`localizeTemplate`). Relations name their target table by
 * key; lookups and rollups name a link's inverse column, which keeps its
 * name in every language.
 */
/**
 * A day counted from the one a base is made from its template: 0 that
 * day, 7 a week later, -3 three days before; `at` gives it a time, in
 * UTC. A template that carried dates of its own showed, months on, a
 * calendar with nothing on its page and tasks that were all overdue.
 */
type TemplateDay = { day: number; at?: string };

/** What a sample row holds as it is written, and once its days are dates. */
type PlainValue = string | number | boolean | string[] | null;
type TemplateValue = PlainValue | TemplateDay;

type TemplateTable<Value> = {
  key: string;
  name: string;
  columns: ColumnDefinition[];
  rows?: Array<Record<string, Value>>;
  views?: Array<{
    name: string;
    viewType: "grid" | "kanban" | "calendar" | "gallery" | "timeline" | "form";
    config?: Record<string, unknown>;
  }>;
};

type TemplateLink = {
  from: string;
  to: string;
  label: string;
  inverseLabel: string;
  /**
   * The link's column names, whatever language its labels are written
   * in: rollups name the inverse one.
   */
  name: string;
  inverseName: string;
  multiple: boolean;
  /** Row links as pairs of row positions in `from` and `to`. */
  rows?: Array<[number, number]>;
};

type TemplateComputed = {
  table: string;
  label: string;
  relation: string;
  target: string;
  fn?: "count" | "sum" | "avg" | "min" | "max" | "concatenate";
};

export type BaseTemplate<Value = TemplateValue> = {
  id: string;
  name: string;
  description: string;
  tables: TemplateTable<Value>[];
  links?: TemplateLink[];
  computed?: TemplateComputed[];
};

/** A day counted from the one the base is made, for a sample row. */
const day = (count: number, at?: string): TemplateDay =>
  at === undefined ? { day: count } : { day: count, at };

function isTemplateDay(value: TemplateValue): value is TemplateDay {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The template as it is made on a given day: each day its rows count
 * from that one becomes the date it names, as a date field keeps one, or
 * the instant when it carries a time.
 */
export function templateOn(
  template: BaseTemplate,
  today: Date,
): BaseTemplate<PlainValue> {
  const dated = (value: TemplateDay): string => {
    const date = new Date(
      Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate() + value.day,
      ),
    )
      .toISOString()
      .slice(0, 10);
    return value.at === undefined ? date : `${date}T${value.at}:00.000Z`;
  };
  return {
    ...template,
    tables: template.tables.map(({ rows, ...table }) => ({
      ...table,
      ...(rows
        ? {
            rows: rows.map((row) =>
              Object.fromEntries(
                Object.entries(row).map(([name, value]) => [
                  name,
                  isTemplateDay(value) ? dated(value) : value,
                ]),
              ),
            ),
          }
        : {}),
    })),
  };
}

const STATUS = (names: string[]) => ({
  options: names.map((name, index) => ({
    name,
    color: (["gray", "blue", "yellow", "green", "red", "purple"] as const)[
      index % 6
    ],
  })),
});

export const BASE_TEMPLATES: readonly BaseTemplate[] = [
  {
    id: "crm",
    name: "CRM",
    description: "Companies, contacts, and deals, with a kanban pipeline.",
    tables: [
      {
        key: "companies",
        name: "Companies",
        columns: [
          { name: "nom", label: "Name", fieldType: "text" },
          {
            name: "secteur",
            label: "Industry",
            fieldType: "single_select",
            config: STATUS(["Industry", "Services", "Public", "Retail"]),
          },
          { name: "site", label: "Website", fieldType: "url" },
          { name: "ville", label: "City", fieldType: "text" },
        ],
        rows: [
          {
            nom: "Acme",
            secteur: "Industry",
            site: "https://acme.example",
            ville: "Lyon",
          },
          {
            nom: "Boreal",
            secteur: "Services",
            site: "https://boreal.example",
            ville: "Nantes",
          },
          { nom: "City of Sète", secteur: "Public", ville: "Sète" },
        ],
      },
      {
        key: "contacts",
        name: "Contacts",
        columns: [
          { name: "nom", label: "Name", fieldType: "text" },
          { name: "email", label: "Email", fieldType: "email" },
          { name: "telephone", label: "Phone", fieldType: "phone" },
          { name: "role", label: "Role", fieldType: "text" },
        ],
        rows: [
          {
            nom: "Inès Martin",
            email: "ines@acme.example",
            role: "Purchasing",
          },
          {
            nom: "Paul Durand",
            email: "paul@boreal.example",
            role: "Executive",
          },
        ],
      },
      {
        key: "deals",
        name: "Deals",
        columns: [
          { name: "titre", label: "Title", fieldType: "text" },
          {
            name: "montant",
            label: "Amount",
            fieldType: "number",
            config: {
              number: { style: "currency", currency: "EUR", precision: 0 },
            },
          },
          {
            name: "etape",
            label: "Stage",
            fieldType: "single_select",
            config: STATUS([
              "Prospect",
              "Qualified",
              "Proposal",
              "Won",
              "Lost",
            ]),
          },
          { name: "cloture", label: "Expected close", fieldType: "date" },
          {
            name: "probabilite",
            label: "Probability",
            fieldType: "number",
            config: { number: { style: "percent", precision: 0 } },
          },
          {
            name: "pondere",
            label: "Weighted amount",
            fieldType: "formula",
            formulaSource: "ROUND({Amount} * {Probability} / 100, 0)",
            config: {
              number: { style: "currency", currency: "EUR", precision: 0 },
            },
          },
        ],
        rows: [
          {
            titre: "Production line",
            montant: 48000,
            etape: "Proposal",
            cloture: day(4),
            probabilite: 60,
          },
          {
            titre: "Annual audit",
            montant: 12000,
            etape: "Qualified",
            cloture: day(35),
            probabilite: 40,
          },
          {
            titre: "Citizen portal",
            montant: 30000,
            etape: "Won",
            cloture: day(-20),
            probabilite: 100,
          },
        ],
        views: [
          {
            name: "Pipeline",
            viewType: "kanban",
            config: { stackColumn: "etape" },
          },
          {
            name: "Due dates",
            viewType: "calendar",
            config: { startColumn: "cloture" },
          },
        ],
      },
    ],
    links: [
      {
        from: "contacts",
        to: "companies",
        label: "Company",
        inverseLabel: "Contacts",
        name: "company",
        inverseName: "contacts",
        multiple: false,
        rows: [
          [0, 0],
          [1, 1],
        ],
      },
      {
        from: "deals",
        to: "companies",
        label: "Company",
        inverseLabel: "Deals",
        name: "company",
        inverseName: "deals",
        multiple: false,
        rows: [
          [0, 0],
          [1, 1],
          [2, 2],
        ],
      },
    ],
    computed: [
      {
        table: "companies",
        label: "Total amount",
        relation: "deals",
        target: "montant",
        fn: "sum",
      },
    ],
  },
  {
    id: "projects",
    name: "Project management",
    description: "Projects and tasks, with a timeline and a status board.",
    tables: [
      {
        key: "projects",
        name: "Projects",
        columns: [
          { name: "nom", label: "Name", fieldType: "text" },
          { name: "debut", label: "Start", fieldType: "date" },
          { name: "fin", label: "End", fieldType: "date" },
          {
            name: "statut",
            label: "Status",
            fieldType: "single_select",
            config: STATUS(["Not started", "In progress", "Completed"]),
          },
        ],
        rows: [
          {
            nom: "Website redesign",
            debut: day(-18),
            fin: day(28),
            statut: "In progress",
          },
          {
            nom: "Data migration",
            debut: day(11),
            fin: day(100),
            statut: "Not started",
          },
        ],
        views: [
          {
            name: "Timeline",
            viewType: "timeline",
            config: { startColumn: "debut", endColumn: "fin" },
          },
        ],
      },
      {
        key: "tasks",
        name: "Tasks",
        columns: [
          { name: "tache", label: "Task", fieldType: "text" },
          {
            name: "statut",
            label: "Status",
            fieldType: "single_select",
            config: STATUS(["To do", "In progress", "In review", "Done"]),
          },
          { name: "echeance", label: "Due date", fieldType: "date" },
          { name: "estimation", label: "Estimate (h)", fieldType: "number" },
          {
            name: "priorite",
            label: "Priority",
            fieldType: "rating",
            config: { ratingMax: 3 },
          },
        ],
        rows: [
          {
            tache: "Mockups",
            statut: "Done",
            echeance: day(-10),
            estimation: 16,
            priorite: 3,
          },
          {
            tache: "Integration",
            statut: "In progress",
            echeance: day(8),
            estimation: 40,
            priorite: 2,
          },
          {
            tache: "Acceptance testing",
            statut: "To do",
            echeance: day(22),
            estimation: 12,
            priorite: 2,
          },
        ],
        views: [
          {
            name: "Board",
            viewType: "kanban",
            config: { stackColumn: "statut" },
          },
        ],
      },
    ],
    links: [
      {
        from: "tasks",
        to: "projects",
        label: "Project",
        inverseLabel: "Tasks",
        name: "project",
        inverseName: "tasks",
        multiple: false,
        rows: [
          [0, 0],
          [1, 0],
          [2, 0],
        ],
      },
    ],
    computed: [
      {
        table: "projects",
        label: "Workload (h)",
        relation: "tasks",
        target: "estimation",
        fn: "sum",
      },
      {
        table: "projects",
        label: "Task count",
        relation: "tasks",
        target: "tache",
        fn: "count",
      },
    ],
  },
  {
    id: "inventory",
    name: "Inventory",
    description: "Products, suppliers, and reorder points.",
    tables: [
      {
        key: "suppliers",
        name: "Suppliers",
        columns: [
          { name: "nom", label: "Name", fieldType: "text" },
          { name: "email", label: "Email", fieldType: "email" },
          { name: "delai", label: "Lead time (days)", fieldType: "number" },
        ],
        rows: [
          {
            nom: "Central Office Supply",
            email: "orders@papeterie.example",
            delai: 5,
          },
        ],
      },
      {
        key: "products",
        name: "Products",
        columns: [
          { name: "produit", label: "Product", fieldType: "text" },
          {
            name: "reference",
            label: "SKU",
            fieldType: "text",
            unique: true,
          },
          { name: "stock", label: "Stock", fieldType: "number" },
          { name: "seuil", label: "Reorder point", fieldType: "number" },
          {
            name: "prix",
            label: "Unit price",
            fieldType: "number",
            config: {
              number: { style: "currency", currency: "EUR", precision: 2 },
            },
          },
          {
            name: "a_commander",
            label: "Reorder",
            fieldType: "formula",
            formulaSource: "{Stock} < {Reorder point}",
          },
          {
            name: "valeur",
            label: "Stock value",
            fieldType: "formula",
            formulaSource: "{Stock} * {Unit price}",
            config: {
              number: { style: "currency", currency: "EUR", precision: 2 },
            },
          },
        ],
        rows: [
          {
            produit: "A4 paper ream",
            reference: "PAP-A4",
            stock: 12,
            seuil: 20,
            prix: 4.9,
          },
          {
            produit: "Blue pens",
            reference: "STY-BL",
            stock: 140,
            seuil: 50,
            prix: 0.6,
          },
        ],
      },
    ],
    links: [
      {
        from: "products",
        to: "suppliers",
        label: "Supplier",
        inverseLabel: "Products",
        name: "supplier",
        inverseName: "products",
        multiple: false,
        rows: [
          [0, 0],
          [1, 0],
        ],
      },
    ],
  },
  {
    id: "bugs",
    name: "Issue tracking",
    description: "Tickets with severity, assignee, and a report form.",
    tables: [
      {
        key: "tickets",
        name: "Tickets",
        columns: [
          { name: "titre", label: "Title", fieldType: "text" },
          { name: "description", label: "Description", fieldType: "long_text" },
          {
            name: "gravite",
            label: "Severity",
            fieldType: "single_select",
            config: STATUS(["Minor", "Major", "Critical"]),
          },
          {
            name: "statut",
            label: "Status",
            fieldType: "single_select",
            config: STATUS(["New", "Investigating", "Fixed", "Closed"]),
          },
          { name: "responsable", label: "Assignee", fieldType: "user" },
          {
            name: "signale_le",
            label: "Reported on",
            fieldType: "created_time",
          },
          { name: "numero", label: "No.", fieldType: "autonumber" },
        ],
        rows: [
          {
            titre: "CSV export is empty",
            gravite: "Major",
            statut: "Investigating",
          },
          {
            titre: "Typo on the home page",
            gravite: "Minor",
            statut: "New",
          },
        ],
        views: [
          {
            name: "By status",
            viewType: "kanban",
            config: { stackColumn: "statut" },
          },
          {
            name: "Report an issue",
            viewType: "form",
            config: {
              form: {
                title: "Report an issue",
                fields: [
                  { column: "titre", required: true },
                  { column: "description" },
                  { column: "gravite" },
                ],
              },
            },
          },
        ],
      },
    ],
  },
  {
    id: "events",
    name: "Events",
    description:
      "Sessions on a calendar, their venues, and a form where attendees register.",
    tables: [
      {
        key: "sessions",
        name: "Sessions",
        columns: [
          { name: "titre", label: "Title", fieldType: "text" },
          { name: "debut", label: "Start", fieldType: "datetime" },
          { name: "fin", label: "End", fieldType: "datetime" },
          {
            name: "format",
            label: "Format",
            fieldType: "single_select",
            config: STATUS(["Talk", "Workshop", "Panel"]),
          },
        ],
        rows: [
          {
            titre: "Opening keynote",
            debut: day(1, "08:30"),
            fin: day(1, "09:30"),
            format: "Talk",
          },
          {
            titre: "Hands-on lab",
            debut: day(1, "13:00"),
            fin: day(1, "16:00"),
            format: "Workshop",
          },
          {
            titre: "Closing panel",
            debut: day(2, "15:00"),
            fin: day(2, "16:00"),
            format: "Panel",
          },
        ],
        views: [
          {
            name: "Calendar",
            viewType: "calendar",
            config: { startColumn: "debut", endColumn: "fin" },
          },
        ],
      },
      {
        key: "venues",
        name: "Venues",
        columns: [
          { name: "nom", label: "Name", fieldType: "text" },
          { name: "ville", label: "City", fieldType: "text" },
          { name: "capacite", label: "Capacity", fieldType: "number" },
        ],
        rows: [
          { nom: "Main hall", ville: "Lyon", capacite: 300 },
          { nom: "Workshop room", ville: "Lyon", capacite: 40 },
        ],
      },
      {
        key: "attendees",
        name: "Attendees",
        columns: [
          { name: "nom", label: "Name", fieldType: "text" },
          { name: "email", label: "Email", fieldType: "email" },
          {
            name: "billet",
            label: "Ticket",
            fieldType: "single_select",
            config: STATUS(["Standard", "Student", "Speaker"]),
          },
        ],
        rows: [
          {
            nom: "Inès Martin",
            email: "ines.martin@example.org",
            billet: "Speaker",
          },
          {
            nom: "Paul Durand",
            email: "paul.durand@example.org",
            billet: "Standard",
          },
        ],
        views: [
          {
            name: "Register",
            viewType: "form",
            config: {
              form: {
                title: "Register",
                fields: [
                  { column: "nom", required: true },
                  { column: "email", required: true },
                  { column: "billet" },
                ],
              },
            },
          },
        ],
      },
    ],
    links: [
      {
        from: "sessions",
        to: "venues",
        label: "Venue",
        inverseLabel: "Sessions",
        name: "lieu",
        inverseName: "sessions",
        multiple: false,
        rows: [
          [0, 0],
          [1, 1],
          [2, 0],
        ],
      },
      {
        from: "attendees",
        to: "sessions",
        label: "Sessions",
        inverseLabel: "Attendees",
        name: "sessions",
        inverseName: "participants",
        multiple: true,
        rows: [
          [0, 0],
          [0, 2],
          [1, 0],
          [1, 1],
        ],
      },
    ],
    computed: [
      {
        table: "sessions",
        label: "Attendee count",
        relation: "participants",
        target: "nom",
        fn: "count",
      },
    ],
  },
  {
    id: "hiring",
    name: "Hiring",
    description:
      "Open positions and their candidates, moved through the stages on a board.",
    tables: [
      {
        key: "positions",
        name: "Positions",
        columns: [
          { name: "intitule", label: "Position", fieldType: "text" },
          {
            name: "equipe",
            label: "Team",
            fieldType: "single_select",
            config: STATUS(["Product", "Engineering", "Operations"]),
          },
          { name: "ouvert", label: "Open", fieldType: "boolean" },
        ],
        rows: [
          { intitule: "Product designer", equipe: "Product", ouvert: true },
          { intitule: "Backend engineer", equipe: "Engineering", ouvert: true },
        ],
      },
      {
        key: "candidates",
        name: "Candidates",
        columns: [
          { name: "nom", label: "Name", fieldType: "text" },
          { name: "email", label: "Email", fieldType: "email" },
          {
            name: "etape",
            label: "Stage",
            fieldType: "single_select",
            config: STATUS([
              "Applied",
              "Screening",
              "Interview",
              "Offer",
              "Hired",
              "Declined",
            ]),
          },
          { name: "candidature", label: "Applied on", fieldType: "date" },
        ],
        rows: [
          {
            nom: "Léa Bernard",
            email: "lea.bernard@example.org",
            etape: "Interview",
            candidature: day(-19),
          },
          {
            nom: "Hugo Petit",
            email: "hugo.petit@example.org",
            etape: "Screening",
            candidature: day(-12),
          },
          {
            nom: "Chloé Moreau",
            email: "chloe.moreau@example.org",
            etape: "Applied",
            candidature: day(-2),
          },
        ],
        views: [
          {
            name: "Pipeline",
            viewType: "kanban",
            config: { stackColumn: "etape" },
          },
        ],
      },
    ],
    links: [
      {
        from: "candidates",
        to: "positions",
        label: "Position",
        inverseLabel: "Candidates",
        name: "poste",
        inverseName: "candidats",
        multiple: false,
        rows: [
          [0, 0],
          [1, 1],
          [2, 1],
        ],
      },
    ],
    computed: [
      {
        table: "positions",
        label: "Candidate count",
        relation: "candidats",
        target: "nom",
        fn: "count",
      },
    ],
  },
];

export function findTemplate(id: string): BaseTemplate | undefined {
  return BASE_TEMPLATES.find((template) => template.id === id);
}
