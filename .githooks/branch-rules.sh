# Shared by the hooks: the branch names docs/BRANCHING.md allows.

# Prints nothing when the name is allowed, or why it is not.
branch_name_problem() {
  case "$1" in
    main|develop) return 0 ;;
  esac
  if printf '%s\n' "$1" | grep -Eq '^(feature|fix|claude)/[a-z0-9][a-z0-9._-]*$'; then return 0; fi
  if printf '%s\n' "$1" | grep -Eq '^(release|hotfix)/[0-9]+\.[0-9]+\.[0-9]+$'; then return 0; fi
  echo "branch '$1' does not follow docs/BRANCHING.md: use feature/<topic>, fix/<topic>, release/<x.y.z> or hotfix/<x.y.z> (lower case, words joined by -)"
}
