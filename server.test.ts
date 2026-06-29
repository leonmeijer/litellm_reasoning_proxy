import { describe, expect, test } from "bun:test"
import { buildLangfuseTraceMeta, buildRequestMetadata } from "./server"

// A fully-populated pod env (orchestrator-set), used to assert the happy path.
const FULL_ENV = {
  INDENTIA_TENANT: "acme",
  INDENTIA_QUEST_ID: "quest-123",
  INDENTIA_AGENT_CLASS: "researcher",
  INDENTIA_SKILL_ID: "web-search",
  ENDUSER_ID: "user-42",
  ENDUSER_ROLE: "analyst",
  POD_NAME: "reasoning-proxy-abc",
}

describe("buildLangfuseTraceMeta (ADR-075 trace enrichment)", () => {
  test("emits the Langfuse-recognised keys when env is set", () => {
    const meta = buildLangfuseTraceMeta(FULL_ENV)
    expect(meta.session_id).toBe("quest-123") // groups one quest's calls
    expect(meta.trace_user_id).toBe("user-42") // end-user wins
    expect(meta.tags).toEqual(["tenant:acme", "agent_class:researcher", "skill_id:web-search"])
    expect(meta.trace_name).toBe("web-search") // skill preferred over agent_class
  })

  test("trace_user_id falls back to tenant when no end-user is known", () => {
    const meta = buildLangfuseTraceMeta({ INDENTIA_TENANT: "acme", INDENTIA_QUEST_ID: "q1" })
    expect(meta.trace_user_id).toBe("acme")
    expect(meta.session_id).toBe("q1")
    expect(meta.tags).toEqual(["tenant:acme"])
    expect(meta.trace_name).toBeUndefined() // no skill, no agent_class
  })

  test("trace_name falls back to agent_class when skill absent", () => {
    const meta = buildLangfuseTraceMeta({ INDENTIA_AGENT_CLASS: "researcher" })
    expect(meta.trace_name).toBe("researcher")
    expect(meta.tags).toEqual(["agent_class:researcher"])
  })

  test("is a no-op (empty object) when env is unset", () => {
    const meta = buildLangfuseTraceMeta({})
    expect(meta).toEqual({})
    expect("session_id" in meta).toBe(false)
    expect("trace_user_id" in meta).toBe(false)
    expect("tags" in meta).toBe(false)
  })

  test("ignores blank / whitespace-only values", () => {
    const meta = buildLangfuseTraceMeta({ INDENTIA_TENANT: "  ", INDENTIA_QUEST_ID: "" })
    expect(meta).toEqual({})
  })
})

describe("buildRequestMetadata (ADR-151 cost lineage — must stay flat)", () => {
  test("emits the flat attribution keys when env is set", () => {
    expect(buildRequestMetadata(FULL_ENV)).toEqual({
      tenant_id: "acme",
      quest_id: "quest-123",
      agent_class: "researcher",
      skill_id: "web-search",
      pod_id: "reasoning-proxy-abc",
      enduser_id: "user-42",
      enduser_role: "analyst",
    })
  })

  test("is a no-op (empty object) when env is unset", () => {
    expect(buildRequestMetadata({})).toEqual({})
  })
})
