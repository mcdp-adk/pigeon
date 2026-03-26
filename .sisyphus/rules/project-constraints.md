# Pigeon Project Principles

> Scope: project-wide principles.
> Purpose: preserve architectural clarity, engineering quality, and decision discipline.

---

## 1. Product Shape

- Keep the project as a focused personal agent system.
- Prefer deepening one coherent product shape over broadening into a platform.
- Favor host-oriented simplicity over control-plane or framework-oriented complexity.

---

## 2. Architecture

- Prefer direct structure over layered abstraction.
- Introduce new architectural concepts only when they are clearly earned.
- Avoid framework-building when product-building is sufficient.
- Let the architecture stay small, legible, and explainable.
- Choose the shape that keeps the system understandable from the outside and from the filesystem.

---

## 3. Capability Design

- Keep the built-in capability surface small.
- Prefer portable capability packaging over bespoke platform machinery.
- Put product power into reusable capabilities rather than deeper host complexity.
- Add new capability layers only when the simpler model has clearly failed.

---

## 4. State and Runtime

- Prefer inspectable, file-backed state.
- Prefer models that are easy to reason about operationally.
- Keep session boundaries simple by default.
- Treat unresolved platform semantics conservatively until they are fully understood.
- Preserve designs that can survive later clarification instead of forcing premature certainty.

---

## 5. Planning

- Decide architectural direction early, then implement in phases.
- Every phase must produce a usable vertical slice.
- Do not treat setup work alone as a milestone.
- While the project is still in draft form, dependency versions should be chosen during planning using the latest stable versions available at that time.
- Do not freeze stale dependency choices too early.

---

## 6. Code Quality

- Code must be simple, clean, and elegant.
- Solve the root problem, not the visible symptom.
- Design from the global best solution, not local convenience.
- Prefer the correct design over the smallest patch.
- Do not cling to minimal fixes when the model is wrong.
- Do not add fallback logic to avoid making a clean decision.
- Do not add bypasses, workaround layers, or compatibility shims unless they are explicitly required.
- Do not preserve outdated paths merely for compatibility.
- Do not optimize for old code by default.

---

## 7. Simplicity

- Prefer fewer concepts.
- Prefer fewer layers.
- Prefer direct naming.
- Prefer flatness unless hierarchy clearly improves understanding.
- Avoid abstraction before repetition proves it is needed.

If something cannot be explained simply, it is probably too early, too complicated, or wrongly designed.

---

## 8. Research Discipline

- Separate facts from design choices.
- Do not write guesses as settled truth.
- Mark uncertainty explicitly.
- Research first when platform behavior or dependency behavior is unclear.
- Let facts inform design, but do not confuse facts with design.

---

## 9. Commits

- Commits must be atomic.
- Commit messages must contain a header only.
- Do not include a body.
- Do not include a footer.

---

## 10. Default Bias

When uncertain, choose the option that is:

- simpler rather than broader
- clearer rather than more flexible
- cleaner rather than more compatible
- more principled rather than more defensive
- easier to reason about rather than more abstract
