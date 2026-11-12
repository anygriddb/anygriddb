import type { NameLocale } from "./made-names";
import type { BaseTemplate } from "./templates";

/**
 * The words of the base templates in each language AnyGridDB writes in
 * but English, their source. Labels name tables, fields, links, views,
 * and forms; values fill options and sample rows. They are apart because
 * one English word can be both ("Industry", a field and an option).
 */
type Words = { labels: Record<string, string>; values: Record<string, string> };

const WORDS: Record<Exclude<NameLocale, "en">, Words> = {
  fr: {
    labels: {
      Companies: "Entreprises",
      Name: "Nom",
      Industry: "Secteur",
      Website: "Site web",
      City: "Ville",
      Contacts: "Contacts",
      Email: "Email",
      Phone: "Téléphone",
      Role: "Rôle",
      Deals: "Affaires",
      Title: "Titre",
      Amount: "Montant",
      Stage: "Étape",
      "Expected close": "Clôture prévue",
      Probability: "Probabilité",
      "Weighted amount": "Montant pondéré",
      Pipeline: "Pipeline",
      "Due dates": "Échéances",
      Company: "Entreprise",
      "Total amount": "Montant total",
      Projects: "Projets",
      Start: "Début",
      End: "Fin",
      Status: "Statut",
      Timeline: "Chronologie",
      Tasks: "Tâches",
      Task: "Tâche",
      "Due date": "Échéance",
      "Estimate (h)": "Estimation (h)",
      Priority: "Priorité",
      Board: "Tableau",
      Project: "Projet",
      "Workload (h)": "Charge (h)",
      "Task count": "Nombre de tâches",
      Suppliers: "Fournisseurs",
      "Lead time (days)": "Délai (jours)",
      Products: "Produits",
      Product: "Produit",
      SKU: "Référence",
      Stock: "Stock",
      "Reorder point": "Seuil de commande",
      "Unit price": "Prix unitaire",
      Reorder: "À commander",
      "Stock value": "Valeur du stock",
      Supplier: "Fournisseur",
      Tickets: "Tickets",
      Description: "Description",
      Severity: "Gravité",
      Assignee: "Responsable",
      "Reported on": "Signalé le",
      "No.": "N°",
      "By status": "Par statut",
      "Report an issue": "Signaler un problème",
    },
    values: {
      Industry: "Industrie",
      Services: "Services",
      Public: "Public",
      Retail: "Commerce",
      "City of Sète": "Ville de Sète",
      Purchasing: "Achats",
      Executive: "Direction",
      Prospect: "Prospect",
      Qualified: "Qualifié",
      Proposal: "Proposition",
      Won: "Gagné",
      Lost: "Perdu",
      "Production line": "Ligne de production",
      "Annual audit": "Audit annuel",
      "Citizen portal": "Portail citoyen",
      "Not started": "Pas commencé",
      "In progress": "En cours",
      Completed: "Terminé",
      "Website redesign": "Refonte du site web",
      "Data migration": "Migration des données",
      "To do": "À faire",
      "In review": "En revue",
      Done: "Fait",
      Mockups: "Maquettes",
      Integration: "Intégration",
      "Acceptance testing": "Recette",
      "Central Office Supply": "Papeterie centrale",
      "A4 paper ream": "Ramette de papier A4",
      "Blue pens": "Stylos bleus",
      Minor: "Mineure",
      Major: "Majeure",
      Critical: "Critique",
      New: "Nouveau",
      Investigating: "En analyse",
      Fixed: "Corrigé",
      Closed: "Fermé",
      "CSV export is empty": "L’export CSV est vide",
      "Typo on the home page": "Coquille sur la page d’accueil",
    },
  },
};

/**
 * A template written in a language: what a person who reads the app in it
 * finds in the base it makes. Names (of tables, fields, links) stay as
 * they are, so views and rollups find what they name; a formula names its
 * fields by their labels, which follow.
 */
export function localizeTemplate(
  template: BaseTemplate,
  locale: NameLocale,
): BaseTemplate {
  if (locale === "en") return template;
  const { labels, values } = WORDS[locale];
  const label = (text: string) => labels[text] ?? text;
  const value = (text: string) => values[text] ?? text;
  const cell = (item: unknown): unknown =>
    typeof item === "string"
      ? value(item)
      : Array.isArray(item)
        ? item.map(cell)
        : item;
  return {
    ...template,
    tables: template.tables.map((table) => ({
      ...table,
      name: label(table.name),
      columns: table.columns.map((column) => {
        const config = column.config as
          { options?: Array<{ name: string }> } | undefined;
        return {
          ...column,
          ...(column.label ? { label: label(column.label) } : {}),
          ...(column.formulaSource
            ? {
                formulaSource: column.formulaSource.replace(
                  /\{([^{}]+)\}/g,
                  (_, name: string) => `{${label(name)}}`,
                ),
              }
            : {}),
          ...(config?.options
            ? {
                config: {
                  ...config,
                  options: config.options.map((option) => ({
                    ...option,
                    name: value(option.name),
                  })),
                },
              }
            : {}),
        };
      }),
      ...(table.rows
        ? {
            rows: table.rows.map(
              (row) =>
                Object.fromEntries(
                  Object.entries(row).map(([key, item]) => [key, cell(item)]),
                ) as typeof row,
            ),
          }
        : {}),
      ...(table.views
        ? {
            views: table.views.map((view) => {
              const form = view.config?.form as { title?: string } | undefined;
              return {
                ...view,
                name: label(view.name),
                ...(form?.title
                  ? {
                      config: {
                        ...view.config,
                        form: { ...form, title: label(form.title) },
                      },
                    }
                  : {}),
              };
            }),
          }
        : {}),
    })),
    ...(template.links
      ? {
          links: template.links.map((link) => ({
            ...link,
            label: label(link.label),
            inverseLabel: label(link.inverseLabel),
          })),
        }
      : {}),
    ...(template.computed
      ? {
          computed: template.computed.map((computed) => ({
            ...computed,
            label: label(computed.label),
          })),
        }
      : {}),
  };
}
