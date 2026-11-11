# Paper outline

Working title: *Tarazu: Evidence-Seeking Reconciliation of Fine-Metal Job-Work Under Measurement Uncertainty*

Every number in the paper comes from `results.json` of the physical trial, produced by `python -m tarazu.trial evaluate`. Figures come from `python -m tarazu.trial figures`. Nothing below is a result yet.

## Claims and where their evidence comes from

| Claim | Evidence | Figure or table | Source in the workspace |
|---|---|---|---|
| C1. Interval-aware balancing cuts false dispute alerts compared with a fixed tolerance | Clean runs; B0, B1; detection sweep | False alerts with exact bounds; detection by size | `figures/false_alerts.svg`, `figures/detection_by_size.svg`, `results.json: false_alerts, sweep` |
| C2. Listing minimal feasible explanations locates faults better than a single guess | Fault runs; single-best-guess ablation | Coverage and localisation per fault class | `figures/coverage_by_class.svg`, `results.json: per_class, coverage, localisation, ablations` |
| C3. Choosing the check with the most information per unit of cost settles disputes in fewer checks than a fixed or random order | Fault runs; B5; cost and prior sensitivity | Checks and minutes to resolution | `figures/checks_to_resolution.svg`, `results.json: checks, sensitivity` |
| Benchmark | The weighed dataset with ground truth and fault labels | Dataset card | `DATASET_CARD.md`, `release/` |
| Second experiment (small sample) | Chatbot (B3) and expert (B4) on the same cases; joint sessions | Baselines table; comprehension | `baselines/BASELINES.md`, `review_results.json` |

## Sections

1. **Introduction.** The dispute, why the weaker party pays, and the three gaps (no explanations, no uncertainty, no next check). State in the abstract: one site, silver, a small number of participants.
2. **Related work.** See the reading list below. Agree that this is data reconciliation; the contribution is discrete missing-record explanations, cheap manual checks and a real workshop benchmark.
3. **Method.** The fine-metal balance as an interval; the nine explanations as typed record edits; exhaustive minimal search with CP-SAT for very large searches; check selection by information gain per cost; stopping and abstaining.
4. **The physical trial.** Materials, phases 0 to 4, blinding with committed keys, the session split, pre-registration.
5. **Results.** C1, C2 and C3 with per-class counts, denominators and exact intervals. No single headline accuracy.
6. **Baselines and people.** B3, B4 and the joint sessions, labelled small-sample.
7. **Limits.** Cancelling faults are invisible by construction. Priors are assumed until real shop data exists. Check costs come from two people. Trust was not measured beyond a few sessions.
8. **Ethics.** No accusation in the wording, both parties see the same screen, consent, payment, redaction, withdrawal.
9. **Release.** Code (MIT) and data (CC BY 4.0).

## Reading list to cite (verify each reference before submission)

| Topic | Work |
|---|---|
| Data reconciliation and gross-error detection | S. Narasimhan and C. Jordache, *Data Reconciliation and Gross Error Detection: An Intelligent Use of Process Data*, Gulf Publishing, 2000 |
| Data reconciliation | J. A. Romagnoli and M. C. Sánchez, *Data Processing and Reconciliation for Chemical Process Operations*, Academic Press, 2000 |
| Diagnosis from first principles (minimal diagnoses) | R. Reiter, "A theory of diagnosis from first principles", *Artificial Intelligence* 32(1), 1987 |
| Multiple-fault diagnosis and choosing the next measurement by entropy | J. de Kleer and B. C. Williams, "Diagnosing multiple faults", *Artificial Intelligence* 32(1), 1987 |
| Minimal conflict explanations | U. Junker, "QuickXplain: preferred explanations and relaxations for over-constrained problems", AAAI 2004 |
| Value of information from an experiment | D. V. Lindley, "On a measure of the information provided by an experiment", *Annals of Mathematical Statistics* 27(4), 1956 |
| Exact binomial intervals | C. J. Clopper and E. S. Pearson, "The use of confidence or fiducial limits illustrated in the case of the binomial", *Biometrika* 26(4), 1934 |
| Rule of three for zero events | J. A. Hanley and A. Lippman-Hand, "If nothing goes wrong, is everything all right?", *JAMA* 249(13), 1983 |
| Information acquisition by language models | QuestBench (cited by the protocol for one-question tasks; confirm the exact citation) |
| Measurement uncertainty | JCGM 100:2008, *Evaluation of measurement data: Guide to the expression of uncertainty in measurement* (GUM) |

## Answers to the objections reviewers will raise

| Objection | Answer |
|---|---|
| "This is data reconciliation from process engineering." | Agreed and cited. The new parts are discrete missing-record explanations, cheap manual checks and the workshop benchmark. |
| "One karigar, one site, silver not gold." | Stated in the abstract. Fine-metal conservation and scale uncertainty do not depend on the metal. A second site is reported if done. |
| "The faults are ones you invented." | The catalogue follows the problem statement and the interviews; real redacted disputes are reported separately as an unseen set. |
| "Your thresholds are tuned." | The pre-registration commit, the key commitments and the frozen split, with `verify` output. |
| "Why not just ask a chatbot?" | B3 answers it with data, and no model does any arithmetic. |

## Where to send it (check current scope and deadlines first)

arXiv (cs.AI, cs.CY) first; then ACM COMPASS, an AI-for-social-good track, or a datasets and benchmarks track if the dataset is the headline.
