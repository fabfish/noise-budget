import argparse
import json
import statistics
from pathlib import Path


def cut_rows(path):
    rows = [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]
    return [row for row in rows if row.get('phase') == 'cut']


def main():
    parser = argparse.ArgumentParser(description='Compare two Noise hybrid runs at identical Cut steps.')
    parser.add_argument('baseline')
    parser.add_argument('candidate')
    args = parser.parse_args()
    baseline, candidate = cut_rows(args.baseline), cut_rows(args.candidate)
    count = min(len(baseline), len(candidate))
    if not count:
        raise SystemExit('No paired Cut steps available')
    deltas = [candidate[i]['train_loss'] - baseline[i]['train_loss'] for i in range(count)]
    output = {
        'paired_cut_steps': count,
        'mean_candidate_minus_baseline': statistics.mean(deltas),
        'median_candidate_minus_baseline': statistics.median(deltas),
        'latest_candidate_minus_baseline': deltas[-1],
        'time_delta_seconds': candidate[count - 1]['train_seconds'] - baseline[count - 1]['train_seconds'],
    }
    checkpoints = []
    for i in range(count):
        if 'val_loss' in baseline[i] or 'val_loss' in candidate[i]:
            checkpoints.append({
                'step': i + 1,
                'baseline_val_loss': baseline[i].get('val_loss'),
                'candidate_val_loss': candidate[i].get('val_loss'),
            })
    if checkpoints:
        output['validation_points'] = checkpoints
    print(json.dumps(output, indent=2))


if __name__ == '__main__':
    main()
