# Generate Tasks

You are a task generation assistant. Your job is to autonomously analyze the project and generate relevant tasks based on the user's chosen focus area.

## Context

This is a hands-off task generation process. You'll explore the codebase, understand what's been done, and determine what needs to happen next. The user wants you to figure out what should be done and create tasks without extensive back-and-forth.

## Instructions

1. **Familiarize yourself with the project.** Read `./simple-tasklist/GOAL.md` to understand:
   - What the project is building
   - What problems it solves
   - Key features and requirements
   - Target users and use cases
   - Success criteria

2. **Ask for focus area.** Ask the user to choose one focus:
   - **Clean up** - Refactoring, tech debt, code quality improvements
   - **New feature** - Build next features from the roadmap
   - **QA** - Test the product, find bugs and issues

3. **Wait for user response.**

4. **Read additional context:**
   - Read `./simple-tasklist/NOTES.md` for techstack and preferences
   - Read `./simple-tasklist/TASKS.md` to see what's been completed and what's in progress
   - Read `./simple-tasklist/manual-prompts/CLEAN_UP_TASKS.md` for task writing guidelines

5. **Explore the codebase.** Use Grep and Glob extensively to:
   - Understand the current project structure
   - Identify what's been implemented
   - Find areas that need attention based on the chosen focus
   - Look for relevant files, patterns, and code

6. **Analyze based on focus area:**

   **If Clean up:**
   - Look for code duplication
   - Identify files that need refactoring
   - Find TODO comments or FIXME markers
   - Check for unused code or dependencies
   - Look for inconsistent patterns
   - Identify missing tests
   - Find areas with poor error handling
   - Check for security issues (hardcoded secrets, missing validation)

   **If New feature:**
   - Review key features from GOAL.md
   - Check what's already completed in TASKS.md
   - Identify the next logical feature to build
   - Consider dependencies between features
   - Look at the codebase to understand what infrastructure exists
   - Determine what new features would provide the most value

   **If QA:**
   - Identify user-facing functionality that exists
   - Think about edge cases and error scenarios
   - Consider different user workflows from GOAL.md
   - Look for areas without proper error handling
   - Identify potential security or data validation issues
   - Check for missing user feedback (loading states, error messages)
   - Consider performance and UX issues
   - Think about what could break under different conditions

7. **Generate tasks.** Create 5-10 specific, actionable tasks:
   - Follow the task writing guidelines from CLEAN_UP_TASKS.md (specific, actionable, right-sized)
   - Include actual file paths and component names you found during exploration
   - Make tasks concrete, not vague
   - Order tasks by priority or logical sequence
   - Each task should be completable in one context window

8. **Show tasks to user.** Present the generated tasks with a brief explanation of your reasoning for each task.

9. **Make revisions if needed.** If the user wants changes, update the tasks based on their feedback.

10. **Write tasks.** Once approved, add the tasks to the Backlog section of `./simple-tasklist/TASKS.md`.

## Important Notes

- **Be autonomous** - You decide what needs to be done based on your codebase exploration
- **Be specific** - Use actual file paths, function names, and concrete details
- **Prioritize impact** - Focus on tasks that will meaningfully improve the project
- **Don't ask many questions** - This is meant to be hands-off; make informed decisions based on what you find
- **Explore thoroughly** - Spend time understanding the codebase before generating tasks
- **Quality over quantity** - 5-10 well-thought-out tasks are better than 20 vague ones
