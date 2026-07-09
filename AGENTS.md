# AGENTS.md — litellm-reasoning-proxy

Agent-instructies voor dit repository.

<!-- indentia-git-workflow -->
## Git-workflow

**Standaard:** geen directe pushes naar `main`. Gebruik een feature branch en Merge Request (GitLab).

1. `git checkout -b agent/<kort-onderwerp>` (of een andere beschrijvende branchnaam)
2. Commit(s) op die branch
3. `git push -u origin HEAD`
4. `glab mr create --title "..." --description "..." --remove-source-branch`
5. Geef de MR-URL terug; merge alleen op verzoek van de gebruiker

**Uitzondering — alleen bij expliciete override van de gebruiker:**
Zinnen als "push direct naar main", "skip MR", "debug mode", of "WIP op main".
Dan mag je committen op `main` en `git push origin main` (geen MR).

### Verboden

- Force-push naar `main`
- Secrets of credentials committen
- `--no-verify` zonder expliciete gebruikersvraag
