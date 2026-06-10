import SwiftUI

struct HeroSection: View {
    @Environment(AppStore.self) private var store
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Specular "shine" -- a small streak of light reflecting off the
            // glass above the caption, like a highlight on a curved pane.
            // Light mode runs near-opaque white with an ink under-stroke so
            // the streak still reads on a bright card.
            Capsule()
                .fill(
                    LinearGradient(
                        colors: [Color.white.opacity(colorScheme == .light ? 0.9 : 0.5), Color.white.opacity(0.0)],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                )
                .overlay {
                    if colorScheme == .light {
                        Capsule().stroke(Color.black.opacity(0.06), lineWidth: 0.5)
                    }
                }
                .frame(width: 36, height: 3)
                .opacity(colorScheme == .light ? 1.0 : 0.6)

            SectionCaption(text: caption)

            HStack(alignment: .firstTextBaseline) {
                Text(heroText)
                    .font(.system(size: 32, weight: .semibold, design: .rounded))
                    .monospacedDigit()
                    .tracking(-1)
                    .foregroundStyle(
                        LinearGradient(
                            colors: [Theme.brandAccent, Theme.brandAccentDeep],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
                    // Soft accent glow: the number looks lit from within the glass.
                    .shadow(color: Theme.brandAccent.opacity(0.35), radius: 12, y: 0)

                Spacer()

                VStack(alignment: .trailing, spacing: 2) {
                    if store.displayMetric == .tokens {
                        HStack(spacing: 2) {
                            Image(systemName: "arrow.up")
                                .font(.system(size: 9, weight: .semibold))
                            Text(formatTokens(Double(store.payload.current.outputTokens)))
                        }
                        .font(.system(size: 11))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                        HStack(spacing: 2) {
                            Image(systemName: "arrow.down")
                                .font(.system(size: 9, weight: .semibold))
                            Text(formatTokens(Double(store.payload.current.inputTokens)))
                        }
                        .font(.system(size: 10.5))
                        .monospacedDigit()
                        .foregroundStyle(.tertiary)
                    } else {
                        Text("\(store.payload.current.calls.asThousandsSeparated()) calls")
                            .font(.system(size: 11))
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                        Text("\(store.payload.current.sessions) sessions")
                            .font(.system(size: 10.5))
                            .monospacedDigit()
                            .foregroundStyle(.tertiary)
                    }
                }
            }

            if !store.isDayMode,
               store.selectedPeriod == .today,
               store.dailyBudget > 0,
               let todayCost = store.todayPayload?.current.cost,
               todayCost >= store.dailyBudget {
                HStack(spacing: 4) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 10))
                    Text("Daily budget of \(store.dailyBudget.asCurrency()) exceeded")
                        .font(.system(size: 11, weight: .medium))
                }
                .foregroundStyle(.orange)
                .padding(.top, 2)
            }

            if let savingsCaption {
                HStack(spacing: 4) {
                    Image(systemName: "leaf.fill")
                        .font(.system(size: 10))
                    Text(savingsCaption)
                        .font(.system(size: 11, weight: .medium))
                }
                .foregroundStyle(.green)
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 12)
        .glassCard(cornerRadius: 14)
    }

    private var heroText: String {
        if store.displayMetric == .tokens || store.displayMetric == .totalTokens {
            let total = Double(store.payload.current.inputTokens + store.payload.current.outputTokens)
            if total >= 1_000_000_000 { return String(format: "%.2fB tok", total / 1_000_000_000) }
            if total >= 1_000_000 { return String(format: "%.1fM tok", total / 1_000_000) }
            if total >= 1_000 { return String(format: "%.0fK tok", total / 1_000) }
            return String(format: "%.0f tok", total)
        }
        return store.payload.current.cost.asCurrency()
    }

    private func formatTokens(_ n: Double) -> String {
        if n >= 1_000_000_000 { return String(format: "%.1fB", n / 1_000_000_000) }
        if n >= 1_000_000 { return String(format: "%.1fM", n / 1_000_000) }
        if n >= 1_000 { return String(format: "%.0fK", n / 1_000) }
        return String(format: "%.0f", n)
    }

    private var caption: String {
        let label = store.payload.current.label.isEmpty ? store.selectedPeriod.rawValue : store.payload.current.label
        if !store.isDayMode && store.selectedPeriod == .today {
            return "\(label) · \(todayDate)"
        }
        return label
    }

    /// Local-model savings caption shown beneath the hero amount when the
    /// user has mapped any local model to a paid baseline via
    /// `quantum-watcher model-savings`. Kept as a separate line so actual spend
    /// (above) and hypothetical avoided spend (below) never get summed
    /// into a misleading "real cost" by the reader.
    private var savingsCaption: String? {
        let savings = store.payload.current.localModelSavings.totalUSD
        guard savings > 0 else { return nil }
        return "Saved \(savings.asCurrency()) with local models"
    }

    private var todayDate: String {
        let formatter = DateFormatter()
        formatter.dateFormat = "EEE MMM d"
        return formatter.string(from: Date())
    }
}
