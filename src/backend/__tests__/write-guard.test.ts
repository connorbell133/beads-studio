import { buildWriteGuard, describeWriteConflict } from "../write-guard";

describe("buildWriteGuard", () => {
  it("guards a status change on the status the surface was showing", () => {
    expect(buildWriteGuard({ status: "in_progress" }, { status: "open" })).toEqual({
      ifStatus: "open",
    });
  });

  it("guards an assignment on the previous holder", () => {
    expect(buildWriteGuard({ assignee: "connor" }, { assignee: "agent-7" })).toEqual({
      ifAssignee: "agent-7",
    });
  });

  it("treats unassigned as a value worth guarding, not an absent one", () => {
    expect(buildWriteGuard({ assignee: "connor" }, { assignee: "" })).toEqual({
      ifAssignee: "",
    });
  });

  it("guards both fields when one edit changes both", () => {
    expect(
      buildWriteGuard({ status: "in_progress", assignee: "connor" }, { status: "open", assignee: "" })
    ).toEqual({ ifStatus: "open", ifAssignee: "" });
  });

  it("does not guard a field the edit is not writing", () => {
    // A priority edit racing an agent's status change is not a conflict the
    // user needs told about; guarding it would only manufacture false alarms.
    expect(buildWriteGuard({}, { status: "open", assignee: "agent-7" })).toBeUndefined();
  });

  it("writes unconditionally when the surface named no pre-edit value", () => {
    expect(buildWriteGuard({ status: "closed" }, undefined)).toBeUndefined();
    expect(buildWriteGuard({ status: "closed" }, {})).toBeUndefined();
  });
});

describe("describeWriteConflict", () => {
  it("names both values and says nothing was written", () => {
    const message = describeWriteConflict({
      id: "bd-1",
      field: "status",
      expected: "open",
      actual: "in_progress",
      attempted: "closed",
    });

    expect(message).toContain("bd-1");
    expect(message).toContain("In Progress");
    expect(message).toContain("Closed");
    expect(message).toContain("Nothing was written");
  });

  it("uses the status labels the user sees, not bd's wire values", () => {
    const message = describeWriteConflict({
      id: "bd-1",
      field: "status",
      expected: "open",
      actual: "in_progress",
      attempted: "blocked",
    });

    expect(message).not.toContain("in_progress");
  });

  it("calls a redundant write redundant rather than a conflict", () => {
    // The other actor set exactly what the user was reaching for. Nothing was
    // lost, so claiming a conflict would be a lie.
    const message = describeWriteConflict({
      id: "bd-1",
      field: "status",
      expected: "open",
      actual: "closed",
      attempted: "closed",
    });

    expect(message).toContain("already set to");
    expect(message).not.toContain("Nothing was written");
  });

  it("renders an empty assignee as unassigned", () => {
    const message = describeWriteConflict({
      id: "bd-1",
      field: "assignee",
      expected: "",
      attempted: "connor",
      actual: "agent-7",
    });

    expect(message).toContain("unassigned");
    expect(message).toContain("agent-7");
  });

  it("still reads as a sentence when bd's live value could not be recovered", () => {
    const message = describeWriteConflict({
      id: "bd-1",
      field: "status",
      expected: "open",
      attempted: "closed",
    });

    expect(message).toContain("someone else changed status");
    expect(message).toContain("Closed");
  });
});
