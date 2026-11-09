import type { ColumnDefinition } from "./schemas";

/**
 * Built-in base templates. Labels are English, the interface's source
 * language. Relations name their target table by key, then lookups and
 * rollups refer to the relation by its derived column name.
 */
export type TemplateTable = {
  key: string;
  name: string;
  columns: ColumnDefinition[];
  rows?: Array<Record<string, string | number | boolean | string[] | null>>;
  views?: Array<{
    name: string;
    viewType: "grid" | "kanban" | "calendar" | "gallery" | "timeline" | "form";
    config?: Record<string, unknown>;
  }>;
};

export type TemplateLink = {
  from: string;
  to: string;
  label: string;
  inverseLabel: string;
  multiple: boolean;
  /** Row links as pairs of row positions in `from` and `to`. */
  rows?: Array<[number, number]>;
};

export type TemplateComputed = {
  table: string;
  label: string;
  relation: string;
  target: string;
  fn?: "count" | "sum" | "avg" | "min" | "max" | "concatenate";
};

export type BaseTemplate = {
  id: string;
  name: string;
  description: string;
  tables: TemplateTable[];
  links?: TemplateLink[];
  computed?: TemplateComputed[];
};

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
          },
        ],
        rows: [
          {
            titre: "Production line",
            montant: 48000,
            etape: "Proposal",
            cloture: "2026-12-15",
            probabilite: 60,
          },
          {
            titre: "Annual audit",
            montant: 12000,
            etape: "Qualified",
            cloture: "2027-01-20",
            probabilite: 40,
          },
          {
            titre: "Citizen portal",
            montant: 30000,
            etape: "Won",
            cloture: "2026-10-30",
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
            debut: "2026-11-02",
            fin: "2026-12-18",
            statut: "In progress",
          },
          {
            nom: "Data migration",
            debut: "2026-12-01",
            fin: "2027-02-28",
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
            echeance: "2026-11-10",
            estimation: 16,
            priorite: 3,
          },
          {
            tache: "Integration",
            statut: "In progress",
            echeance: "2026-11-28",
            estimation: 40,
            priorite: 2,
          },
          {
            tache: "Acceptance testing",
            statut: "To do",
            echeance: "2026-12-12",
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
];

export function findTemplate(id: string): BaseTemplate | undefined {
  return BASE_TEMPLATES.find((template) => template.id === id);
}
