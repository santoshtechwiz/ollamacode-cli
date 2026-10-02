import read_file from '../filesystem/read-file.tool';
import write_file from '../filesystem/write-file.tool';
import delete_file from '../filesystem/delete-file.tool';
import edit_file from '../filesystem/edit-file.tool';
import list_directory from '../filesystem/list-directory.tool';
import create_directory from '../filesystem/create-directory.tool';
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
import start_subprocess from '../process/start-subprocess.tool';
import stop_subprocess from '../process/stop-subprocess.tool';
import stop_process from '../process/stop-process.tool';
import subprocess_status from '../process/subprocess-status.tool';
import ensure_toolchain from '../agent/environment/ensure-toolchain.tool';
import json_patch from '../filesystem/json-patch.tool';
import yaml_patch from '../filesystem/yaml-patch.tool';
import diffTool from '../filesystem/diff.tool';
import file_info from '../filesystem/file-info.tool';
import changed_files from '../git/changed-files.tool';
import merge_conflicts from '../git/merge-conflicts.tool';
import symbol_references from '../search/symbol-references.tool';
import code_review from '../review/code-review.tool';
import search_symbols from '../search/search-symbols.tool';
import commit_message from '../git/commit-message.tool';
import undo from '../filesystem/undo.tool';
import load_tools from '../core/load-tools.tool';

type ToolDef = import('../../types.ts').ToolDef;

/**
 * The single ordered list of built-in tool definitions.
 * Registration order determines prompt order; keep it stable.
 */
export const BUILT_IN_TOOLS: ToolDef[] = [
  read_file,
  write_file,
  delete_file,
  edit_file,
  list_directory,
  create_directory,
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
  present_plan,
  start_subprocess,
  stop_subprocess,
  stop_process,
  subprocess_status,
  ensure_toolchain,
  json_patch,
  yaml_patch,
  diffTool,
  file_info,
  changed_files,
  merge_conflicts,
  symbol_references,
  code_review,
  search_symbols,
  commit_message,
  undo,
  load_tools,
];
