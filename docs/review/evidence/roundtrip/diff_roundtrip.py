"""Diff two OOTP CSV exports to see what an in-game roster import actually changed.

Usage:
  python diff_roundtrip.py <before_csv_dir> <after_csv_dir> --players 12345,67890 [--org 15]

Prints, for each player id: every column that changed in players.csv,
players_roster_status.csv, players_contract.csv and team_roster.csv (list membership),
then every new row in the log tables (messages, trade_history, league_events,
players_salary_history) that mentions one of the players or appeared after the
first export. Works with any OOTP field delimiter (comma, semicolon, tab, pipe).
"""
import csv
import os
import sys

LOG_TABLES = ["messages", "trade_history", "league_events", "players_salary_history"]
PLAYER_TABLES = ["players", "players_roster_status", "players_contract"]


def sniff(path):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        head = f.readline()
    return max([",", ";", "\t", "|"], key=head.count)


def load(dir_, table):
    path = os.path.join(dir_, table + ".csv")
    if not os.path.exists(path):
        return []
    with open(path, "r", encoding="utf-8", errors="replace", newline="") as f:
        return list(csv.DictReader(f, delimiter=sniff(path)))


def by_player(rows):
    out = {}
    for r in rows:
        pid = r.get("player_id")
        if pid is not None:
            out.setdefault(pid, []).append(r)
    return out


def main():
    args = sys.argv[1:]
    if len(args) < 2:
        print(__doc__)
        sys.exit(1)
    before, after = args[0], args[1]
    players = set()
    org = None
    if "--players" in args:
        players = set(args[args.index("--players") + 1].split(","))
    if "--org" in args:
        org = args[args.index("--org") + 1]

    if org and not players:
        for r in load(after, "players"):
            if r.get("organization_id") == org:
                players.add(r["player_id"])
        print(f"{len(players)} players in organization {org}")

    for table in PLAYER_TABLES:
        b = by_player(load(before, table))
        a = by_player(load(after, table))
        print(f"\n== {table} ==")
        for pid in sorted(players, key=int):
            rb = b.get(pid, [{}])[0]
            ra = a.get(pid, [{}])[0]
            changed = {k: (rb.get(k), ra.get(k)) for k in set(rb) | set(ra) if rb.get(k) != ra.get(k)}
            if changed:
                name = f"{ra.get('first_name', '')} {ra.get('last_name', '')}".strip() or pid
                print(f"  {name} ({pid}):")
                for k, (v0, v1) in sorted(changed.items()):
                    print(f"      {k}: {v0!r} -> {v1!r}")

    print("\n== team_roster (team_id/list_id membership) ==")
    tb = by_player(load(before, "team_roster"))
    ta = by_player(load(after, "team_roster"))
    for pid in sorted(players, key=int):
        sb = sorted((r.get("team_id"), r.get("list_id")) for r in tb.get(pid, []))
        sa = sorted((r.get("team_id"), r.get("list_id")) for r in ta.get(pid, []))
        if sb != sa:
            print(f"  {pid}: {sb} -> {sa}")

    for table in LOG_TABLES:
        rb = load(before, table)
        ra = load(after, table)
        key = lambda r: tuple(sorted(r.items()))
        seen = {key(r) for r in rb}
        new = [r for r in ra if key(r) not in seen]
        print(f"\n== {table}: {len(new)} new row(s) ==")
        for r in new[:40]:
            text = " | ".join(f"{k}={v}" for k, v in r.items() if v not in ("", "0", "NULL") )
            flag = " <-- tracked player" if any(p in text for p in players) else ""
            print(f"  {text[:300]}{flag}")


if __name__ == "__main__":
    main()
