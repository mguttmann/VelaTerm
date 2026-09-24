import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { InfoTab } from "./InfoTab";
import { useTermStore } from "../../store/termStore";
import type { Session } from "../../types";

vi.mock("../../ipc/commands", () => ({
  agentContextInfo: vi.fn().mockResolvedValue(null),
  agentTurnStats: vi.fn().mockResolvedValue({ model: "Kiro model", contextLimit: 200000, contextPercent: 37 }),
  usageRefresh: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../ipc/info", () => ({
  processStats: vi.fn().mockResolvedValue(null),
  systemStats: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../hooks/useGitBranch", () => ({ useGitBranch: () => "main" }));

beforeAll(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});
afterEach(() => {
  cleanup();
  useTermStore.setState({ infoCollapsed: {} });
});

const session = {
  id: "s1",
  kind: "terminal",
  name: "shell",
  agentSessionId: null,
  projectId: "p1",
} as unknown as Session;

describe("InfoTab sections", () => {
  it("displays Kiro's reported model and percentage without inventing token usage", async () => {
    render(<InfoTab session={{ ...session, kind: "kiro", agentSessionId: "native-id" }} cwd="/tmp" />);
    expect(await screen.findByText("Kiro model")).toBeTruthy();
    expect(screen.getByText("37%")).toBeTruthy();
    expect(screen.getByText("— / 200.0k")).toBeTruthy();
    expect(screen.queryByText("turn tokens")).toBeNull();
    expect(screen.queryByText("session total")).toBeNull();
  });
  it("gives every section a collapse button and folds its body away", () => {
    render(<InfoTab session={session} cwd="/tmp" />);
    expect(screen.getByText("Process")).toBeTruthy();
    expect(screen.getByText("Resources")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Collapse section" })).toHaveLength(2);

    // The collapse control belongs to its own header, so folding Process leaves Resources intact.
    const process = screen.getByText("Process").closest(".insp-section") as HTMLElement;
    fireEvent.click(within(process).getByRole("button", { name: "Collapse section" }));
    expect(within(process).queryByText("shell")).toBeNull();
    expect(screen.getByText("Resources")).toBeTruthy();
    expect(useTermStore.getState().infoCollapsed).toEqual({ agent: true });
  });
});
