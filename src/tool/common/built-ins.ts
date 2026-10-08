import read_file from '../filesystem/read-file.tool';
import write_file from '../filesystem/write-file.tool';
import delete_file from '../filesystem/delete-file.tool';
import move_file from '../filesystem/move-file.tool';
import edit_file from '../filesystem/edit-file.tool';
import list_directory from '../filesystem/list-directory.tool';
import find_files from '../search/find-files.tool';
import grep_content from '../search/grep-content.tool';
import exec_shell from '../process/exec-shell.tool';
import run_script from '../process/run-script.tool';
import gitTool from '../git/git.tool';
import web_search from '../web/web-search.tool';
import web_fetch from '../web/web-fetch.tool';
import read_document from '../document/read-document.tool';
import write_document from '../document/write-document.tool';
import ask_user from '../agent/interaction/ask-user.tool';
import save_memory from '../agent/memory/save-memory.tool';
import todo_write from '../../agent/planning/todo-write.tool';
import present_plan from '../../agent/planning/present-plan.tool';
import enter_plan_mode from '../../agent/planning/enter-plan-mode.tool';
import stop_subprocess from '../process/stop-subprocess.tool';
import stop_process from '../process/stop-process.tool';
import subprocess_status from '../process/subprocess-status.tool';
import undo from '../filesystem/undo.tool';
import delegate_task from '../../agent/subagent/delegate.tool';

type ToolDef = import('../../types.ts').ToolDef;

/**
 * The single ordered list of built-in tool definitions.
 * Registration order determines prompt order; keep it stable.
 */
export const BUILT_IN_TOOLS: ToolDef[] = [
  read_file,
  write_file,
  delete_file,
  move_file,
  edit_file,
  list_directory,
  find_files,
  grep_content,
  exec_shell,
  run_script,
  gitTool,
  web_search,
  web_fetch,
  read_document,
  write_document,
  ask_user,
  save_memory,
  todo_write,
  enter_plan_mode,
  present_plan,
  stop_subprocess,
  stop_process,
  subprocess_status,
  undo,
  delegate_task,
];
