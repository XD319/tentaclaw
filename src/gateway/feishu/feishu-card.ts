export function renderTaskAcceptedCard(taskId: string, input: string): string {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    elements: [
      { tag: "markdown", content: `Task accepted: \`${taskId}\`` },
      { tag: "markdown", content: input.slice(0, 300) }
    ],
    header: { title: { content: "Auto Talon Task", tag: "plain_text" } }
  });
}

export function renderTaskProgressCard(taskId: string, detail: string): string {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    elements: [{ tag: "markdown", content: `Task \`${taskId}\` progress: ${detail}` }],
    header: { title: { content: "Task Progress", tag: "plain_text" } }
  });
}

export function renderTaskResultCard(taskId: string, status: string, output: string | null): string {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    elements: [
      { tag: "markdown", content: `Task \`${taskId}\` finished with status: **${status}**` },
      { tag: "markdown", content: output === null ? "_no output_" : output.slice(0, 1000) }
    ],
    header: { title: { content: "Task Result", tag: "plain_text" } }
  });
}

export function renderApprovalCard(taskId: string, approvalId: string): string {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    elements: [
      { tag: "markdown", content: `Task \`${taskId}\` requires approval.` },
      {
        actions: [
          {
            tag: "button",
            text: { content: "Approve", tag: "plain_text" },
            type: "primary",
            value: { approvalId, decision: "allow", taskId }
          },
          {
            tag: "button",
            text: { content: "Deny", tag: "plain_text" },
            type: "danger",
            value: { approvalId, decision: "deny", taskId }
          }
        ],
        tag: "action"
      }
    ],
    header: { title: { content: "Approval Required", tag: "plain_text" } }
  });
}
