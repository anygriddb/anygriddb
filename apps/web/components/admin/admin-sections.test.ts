import { LayoutDashboard, ScrollText, Users } from "lucide-react";
import { describe, expect, it } from "vitest";
import { locate, type AdminSection } from "./admin-sections";

const sections: AdminSection[] = [
  {
    id: "overview",
    label: "Overview",
    icon: LayoutDashboard,
    pages: [{ to: "/admin", label: "Overview" }],
  },
  {
    id: "people",
    label: "People",
    icon: Users,
    pages: [
      { to: "/admin/people/accounts", label: "Accounts" },
      { to: "/admin/people/sessions", label: "Sessions" },
    ],
  },
  {
    id: "trails",
    label: "Trails",
    icon: ScrollText,
    pages: [
      { to: "/admin/trails", label: "Changes" },
      { to: "/admin/trails/sign-ins", label: "Sign-ins" },
    ],
  },
];

describe("where an address sits in Administration", () => {
  it("finds the section and the page, the longest address winning", () => {
    expect(locate(sections, "/admin")?.section.id).toBe("overview");
    expect(locate(sections, "/admin/")?.section.id).toBe("overview");
    expect(locate(sections, "/admin/trails/sign-ins")?.page.label).toBe(
      "Sign-ins",
    );
    expect(locate(sections, "/admin/trails")?.page.label).toBe("Changes");
    const account = locate(
      sections,
      "/admin/people/accounts/0b9f6c1e-0000-4000-8000-000000000001",
    );
    expect(account?.section.id).toBe("people");
    expect(account?.page.label).toBe("Accounts");
  });

  it("finds nothing for an address it does not hold", () => {
    expect(locate(sections, "/admin/security")).toBeNull();
    expect(locate(sections, "/admin/trailsx")).toBeNull();
    expect(locate([], "/admin")).toBeNull();
  });
});
