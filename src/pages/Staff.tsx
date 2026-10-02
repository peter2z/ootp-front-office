import { useEffect, useState } from 'react';
import { apiGet } from '../api';
import { Th } from '../Th';
import { formatMoney } from '../stats';
import { Tip } from '../playerModal';

interface StaffMember {
  role: string; coach_id: number; name: string; age: number; experience: number;
  salary: number; yearsLeft: number; formerPlayer: boolean;
  ratings: Array<{ label: string; value: number }>;
}
interface FarmCoach {
  role: string; coach_id: number; name: string; age: number; experience: number;
  ratings: Array<{ label: string; value: number }>;
}
interface FarmClub {
  team: string; team_id: number; levelName: string;
  record: { w: number; l: number; pct: number } | null;
  coaches: FarmCoach[];
}
interface Candidate {
  seat: string; incumbent: string; incumbentValue: number;
  coach_id: number; name: string; currentRole: string;
  team: string; levelName: string;
  record: { w: number; l: number; pct: number } | null;
  age: number; value: number; gap: number;
}
interface StaffData { staff: StaffMember[]; farmStaff: FarmClub[]; promotionCandidates: Candidate[] }

const money = formatMoney;

/**
 * What the promotion table compares, which is not on the cards.
 *
 * The cards show a coach's skills; the table ranks men on OOTP's own grade for
 * a seat (manager_value, pitching_coach_value, hitting_coach_value in the
 * export). Across the 4,500 coaches of a real save, the pitching and hitting
 * grades equal three parts Teach Pitching (Teach Hitting) to one part the
 * average of Handle Players, Handle Veterans and Handle Rookies, to the
 * rounding; a manager's takes in more than his card shows. So one man read 136
 * and 115 on his card and 131 in the table, and nothing on the page said they
 * were different measures.
 */
const TIP_SEAT_SCORE =
  "OOTP's own grade of a coach for this job, out of 200. It blends several ratings, so it will " +
  'not match any one bar on the cards.';

/** Coach ratings use OOTP's internal 1-200 scale. */
function CoachBar({ value }: { value: number }) {
  const pct = Math.min(100, (value / 200) * 100);
  return (
    <div className="rating wide">
      <div className="rating-bar" style={{ width: `${pct}%`, background: `hsl(${(pct / 100) * 120}, 65%, 45%)` }} />
      <span>{value}</span>
    </div>
  );
}

export function Staff({ orgId }: { orgId: number }) {
  const [data, setData] = useState<StaffData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    apiGet<StaffData>(`/api/staff/${orgId}`).then(setData).catch((e) => setError(e.message));
  }, [orgId]);

  if (error) return <div className="banner error">{error}</div>;
  if (!data) return <p className="muted">Checking the clubhouse offices…</p>;

  /*
   * The table's incumbent figure, put back on the card of the man it belongs
   * to. The staff list carries only the skill bars, so a card shows a seat
   * score exactly where the table quotes one — which is where the two numbers
   * for one man can be mistaken for each other.
   */
  const seatScores = new Map(
    data.promotionCandidates.map((c) => [`${c.seat}|${c.incumbent}`, c.incumbentValue])
  );
  const skillsOf = (seat: string, name: string): string =>
    (data.staff.find((m) => m.role === seat && m.name === name)?.ratings ?? [])
      .map((r) => `${r.label} ${r.value}`)
      .join(' · ');

  return (
    <div>
      <h2>Major League Staff</h2>
      <div className="staff-grid">
        {data.staff.map((s) => (
          <div key={s.coach_id} className="staff-card">
            <span className="story-category">{s.role}</span>
            <h3 className="staff-name">{s.name}</h3>
            <span className="muted">
              Age {s.age} · {s.experience} yrs exp{s.formerPlayer ? ' · former player' : ''}
              {s.salary ? ` · ${money(s.salary)}/yr, ${s.yearsLeft} yr${s.yearsLeft === 1 ? '' : 's'} left` : ''}
            </span>
            <div className="rating-rows">
              {s.ratings.map((r) => (
                <div key={r.label} className="rating-row">
                  <span className="rating-row-label">{r.label}</span>
                  <CoachBar value={r.value} />
                </div>
              ))}
              {seatScores.has(`${s.role}|${s.name}`) && (
                <div className="rating-row">
                  <span className="rating-row-label">
                    <Tip label="Seat score" tip={TIP_SEAT_SCORE} />
                  </span>
                  <CoachBar value={seatScores.get(`${s.role}|${s.name}`)!} />
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {data.promotionCandidates.length > 0 && (
        <>
          <h2>Ready For a Job Up Here</h2>
          <p className="muted hint-line">
            Seat score is OOTP&rsquo;s own grade of a coach for one particular job, out of 200. It is
            not one of the bars on the cards above: for a pitching or hitting coach it is about three
            parts teaching skill to one part how he handles players, and a manager&rsquo;s takes in
            more, so it usually sits between the bars rather than matching one.
          </p>
          <p className="muted hint-line">
            OOTP rates every coach for every seat, not only the one he holds, so each man on the
            farm is measured against whoever has the major-league job — including seats he does not
            currently occupy. Records are shown for context but deliberately left out of the
            ranking: a coach does not pick his roster, and a good one on a poor affiliate should not
            be buried for it.
          </p>
          <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <Th>Coach</Th><Th>Now</Th><Th>Club</Th><Th>Could take over as</Th>
                <Th tip={`${TIP_SEAT_SCORE} The figure in brackets is the lead over the man who has the job now.`}>
                  Seat score
                </Th>
                <Th tip="The man who has the job now, with his own seat score. His skill ratings are underneath, as they appear on his card.">
                  Incumbent
                </Th>
              </tr>
            </thead>
            <tbody>
              {data.promotionCandidates.map((c, i) => (
                <tr key={i}>
                  <td className="name">{c.name} <span className="muted">{c.age}</span></td>
                  <td className="muted">{c.currentRole}</td>
                  <td>
                    <span className="level-tag">{c.levelName}</span> {c.team}
                    {c.record && (
                      <span className="muted"> {c.record.w}-{c.record.l}</span>
                    )}
                  </td>
                  <td><strong>{c.seat}</strong></td>
                  <td className="num good-text">{c.value} <span className="muted">(+{c.gap})</span></td>
                  <td className="muted">
                    {c.incumbent} {c.incumbentValue}
                    {skillsOf(c.seat, c.incumbent) && (
                      <div className="seen-between">{skillsOf(c.seat, c.incumbent)}</div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </>
      )}

      <h2>Farm System Staff</h2>
      <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <Th>Team</Th><Th>Role</Th><Th>Coach</Th><Th>Age</Th>
            <Th>Teach Hitting</Th><Th>Teach Pitching</Th><Th>Handle Rookies</Th>
          </tr>
        </thead>
        <tbody>
          {data.farmStaff.flatMap((club) =>
            club.coaches.map((c, j) => (
              <tr key={`${club.team_id}-${c.coach_id}`}>
                {/* The club is named once per affiliate rather than on every
                    row, so the three seats read as one staff */}
                <td>
                  {j === 0 && (
                    <>
                      <span className="level-tag">{club.levelName}</span> {club.team}
                      {club.record && (
                        <span className="muted"> {club.record.w}-{club.record.l}</span>
                      )}
                    </>
                  )}
                </td>
                <td className="muted">{c.role}</td>
                <td className="name">{c.name}</td>
                <td>{c.age}</td>
                {c.ratings.map((r) => (
                  <td key={r.label}><CoachBar value={r.value} /></td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
      </div>
    </div>
  );
}
