---
title: Run your work with an agent team
description: A method for running real work with a team of named AI agents, each its own Claude Code session with its own queue in StoryOS, and the six open skills that set it up.
sidebar:
  order: 11
---

This is a method for running a body of work with a **team of named AI agents**. Each agent is a
separate, long-lived Claude Code session with its own queue in StoryOS, a lane it owns, a list of
things it must never touch, and a validator who checks its work before anything reaches the world.

It is the method behind the agent team that builds StoryOS. It ships as six Claude Code skills in one
public repository:
**[github.com/ikrasovytskyi/skills](https://github.com/ikrasovytskyi/skills)**.

## What the method is

- **Agents coordinate through records, not messages.** A message is delivered once and gone. A
  record survives a closed laptop, a crashed session and a week of nobody looking, and the queue
  doubles as the audit trail: it is how you answer "what happened overnight" without reading ten
  transcripts.
- **Three kinds of agent, and a team needs all three.** *Signal* agents experience the work as its
  audience does (operators using the product, readers of a target segment) and report what they
  found. *Judgement* agents decide: a validator who tries to refute findings and checks finished
  work, a writer who turns validated findings into work a maker can finish without asking a
  question, and an owner who is the only one who can say no, set priority and admit work. *Make*
  agents each own one lane. A team of only makers produces a lot, fast, and wrong.
- **A lane has exactly one owner**, and is named as addresses (paths, surfaces, systems), not
  topics. "Don't touch the API" is not a boundary; a path is.
- **Nobody checks their own work, and every agent can refuse.** Makers do not approve their own
  output, and each agent has an explicit "you must never" list and the standing to invoke it.
- **The gate.** A maker finishes, records what it did and did not verify, and hands over. The
  validator exercises each acceptance criterion rather than reading it, then lands the work, sends
  it back or escalates. In engineering, landing means merging. For a content team it means
  publishing, which is harder to undo.

## The phases

The skills run in order. Most people start at phase 0 and spend their time in phase 4.

| Phase | Skill | What it does |
|---|---|---|
| 0 | [`plan-agent-team`](https://github.com/ikrasovytskyi/skills/blob/main/skills/plan-agent-team/SKILL.md) | Works out whether you need a team at all, and how big. It interviews you, reads what it can from your repository, and proposes a right-sized roster with a phased rollout. It will tell you not to build a team when the work doesn't repeat, one person does all of it, there's no way to check the output, or nobody will read the queue. |
| 1 | [`agent-fleet`](https://github.com/ikrasovytskyi/skills/blob/main/skills/agent-fleet/SKILL.md) | Designs the roster: who exists, what each owns, what each must never touch, and who checks whom. The method is domain-neutral and a profile supplies the vocabulary (an engineering profile and a marketing profile are included). |
| 2 | [`agent-fleet-provision`](https://github.com/ikrasovytskyi/skills/blob/main/skills/agent-fleet-provision/SKILL.md) | Builds the infrastructure with StoryOS as the backend: the queue databases and their fields (issues, agents, agent runs, scenarios), then each agent's workspace. |
| 3 | [`agent-fleet-launch`](https://github.com/ikrasovytskyi/skills/blob/main/skills/agent-fleet-launch/SKILL.md) | Starts the team: one session per agent, identity checked, queue count verified, then the loop. It also covers stopping the team cleanly and moving it to another machine or account. |
| 4 | [`agent-fleet-operate`](https://github.com/ikrasovytskyi/skills/blob/main/skills/agent-fleet-operate/SKILL.md) | Runs it: the gate, routing work nobody owns, and correcting an agent so the correction sticks. It carries a catalogue of the silent failures seen so far. |
| any | [`agent-fleet-marketing`](https://github.com/ikrasovytskyi/skills/blob/main/skills/agent-fleet-marketing/SKILL.md) | The entry point for a marketing or content team: writers per channel, an editor, a fact-checker, an owner who decides what publishes, and readers who report whether it lands. It points into the same method with the marketing vocabulary. |

## What you need

- **Claude Code.** Each agent is a long-lived Claude Code session, and the launch phase uses its
  loop.
- **A StoryOS workspace** as the queue, hosted or [self-hosted](/self-hosting/overview/). The
  provisioning skill creates the databases by hand; there is no one-click pack for this.
- **For an engineering team:** a git repository with branch protection, and room for one worktree per
  agent.

## Install

```bash
git clone https://github.com/ikrasovytskyi/skills.git
cp -R skills/skills/* ~/.claude/skills/
```

Start a new Claude Code session and say "plan an agent team", or run `/plan-agent-team`. Keep the
folders whole: several skills read files from each other's `references/` directory.

## What this is not

- **Not a framework.** There is no code to run. These are instructions an agent follows.
- **Not finished.** There is no operations profile yet, and the method has mostly been exercised on
  one engineering team and one content team. If something fails for you, the failure catalogue in
  `agent-fleet-operate` is where it belongs: open an issue on the repository.

## Related

- [Skills](/concepts/skills/): how StoryOS stores and shares skills.
- [Approval gates](/concepts/approval-gates/): an enforced gate for destructive actions, a different
  thing from the review gate described above.
