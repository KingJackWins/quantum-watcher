import SwiftUI

/// Design tokens. Accent colors are driven by ThemeState so the user can switch palettes.
@MainActor
enum Theme {
    static let brandForest        = Color(red: 0x0F/255.0, green: 0x6B/255.0, blue: 0x35/255.0)

    static var brandAccent: Color { ThemeState.shared.preset.base }
    static var brandAccentLight: Color { ThemeState.shared.preset.light }
    static var brandAccentDeep: Color { ThemeState.shared.preset.deep }
    static var brandAccentGlow: Color { ThemeState.shared.preset.glow }

    static let warmSurface       = Color(red: 0xFA/255.0, green: 0xF7/255.0, blue: 0xF3/255.0)
    static let warmSurfaceDark   = Color(red: 0x1C/255.0, green: 0x18/255.0, blue: 0x16/255.0)

    static let categoricalClaude = Color(red: 0xC9/255.0, green: 0x52/255.0, blue: 0x1D/255.0)
    static let categoricalCursor = Color(red: 0x3F/255.0, green: 0x6B/255.0, blue: 0x8C/255.0)
    static let categoricalCodex  = Color(red: 0x4A/255.0, green: 0x7D/255.0, blue: 0x5C/255.0)

    static let oneShotGood  = Color(red: 0x30/255.0, green: 0xD1/255.0, blue: 0x58/255.0)
    static let oneShotMid   = Color(red: 0xFF/255.0, green: 0x9F/255.0, blue: 0x0A/255.0)
    static let oneShotLow   = Color(red: 0xFF/255.0, green: 0x45/255.0, blue: 0x3A/255.0)

    // Semantic colors -- tuned to sit alongside the terracotta accent without clashing.
    static let semanticDanger  = Color(red: 0xC8/255.0, green: 0x3F/255.0, blue: 0x2C/255.0) // brick-red, terracotta-leaning
    static let semanticWarning = Color(red: 0xD9/255.0, green: 0x8F/255.0, blue: 0x29/255.0) // amber, warmer than vanilla
    static let semanticSuccess = Color(red: 0x4E/255.0, green: 0xA8/255.0, blue: 0x65/255.0) // muted green that holds against terracotta

    // Legacy glass tokens (kept for call sites outside the new Glass system).
    static let glassBackground = Color.white.opacity(0.06)
    static let glassBorder = Color.white.opacity(0.12)
    static let glassHighlight = Color.white.opacity(0.08)
    static let glassShadow = Color.black.opacity(0.15)
}

/// Liquid-glass design system, resolved per color scheme.
///
/// Dark mode: low-opacity white overlays read as "sheen" over dark materials.
/// Light mode: those same white overlays are nearly invisible on a light
/// material backdrop, so the recipe swaps to bright frost fills, near-white
/// specular rims, dark definition lines, and ink-toned separators/tracks.
@MainActor
enum Glass {
    /// Simulates light catching the top-leading edge of a pane of glass.
    /// Light: a bright white rim falling to a soft quarter-white, paired with
    /// a dark outer definition line in `GlassCard`. Dark: bright at top-left,
    /// falling off through the middle, with a faint bounce-light on the
    /// bottom-trailing edge.
    static func specularBorder(for scheme: ColorScheme) -> LinearGradient {
        if scheme == .light {
            return LinearGradient(
                stops: [
                    .init(color: .white.opacity(0.9), location: 0.0),
                    .init(color: .white.opacity(0.2), location: 1.0),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        }
        return LinearGradient(
            stops: [
                .init(color: .white.opacity(0.28), location: 0.0),
                .init(color: .white.opacity(0.06), location: 0.5),
                .init(color: .white.opacity(0.12), location: 1.0),
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }

    /// Frost layer painted over the material so cards feel solid, not hollow.
    /// Light mode uses a strong white frost so the slab clearly brightens
    /// above the backdrop.
    static func cardFill(for scheme: ColorScheme) -> Color {
        scheme == .light ? Color.white.opacity(0.5) : Color.white.opacity(0.04)
    }

    /// Soft vertical sheen across the top ~45% of a card -- the "light from
    /// above" that makes the surface read as curved glass.
    static func topSheen(for scheme: ColorScheme) -> LinearGradient {
        LinearGradient(
            colors: [Color.white.opacity(scheme == .light ? 0.55 : 0.10), .clear],
            startPoint: .top,
            endPoint: UnitPoint(x: 0.5, y: 0.45)
        )
    }

    /// Hairline separator. White sheen reads in dark mode; light mode needs an
    /// ink line because white hairlines vanish on a light backdrop.
    static func separator(for scheme: ColorScheme) -> LinearGradient {
        LinearGradient(
            colors: [
                .clear,
                scheme == .light ? Color.black.opacity(0.12) : Color.white.opacity(0.14),
                .clear,
            ],
            startPoint: .leading,
            endPoint: .trailing
        )
    }

    /// Recessed track fill behind progress bars.
    static func trackFill(for scheme: ColorScheme) -> Color {
        scheme == .light ? Color.black.opacity(0.07) : Color.white.opacity(0.08)
    }

    /// Card drop shadow: softer and larger in light mode so the slab clearly
    /// lifts off the bright backdrop.
    static func cardShadow(for scheme: ColorScheme) -> (color: Color, radius: CGFloat, y: CGFloat) {
        scheme == .light
            ? (Color.black.opacity(0.12), 14, 7)
            : (Color.black.opacity(0.18), 10, 5)
    }

    /// Accent glow pattern: apply as `.shadow(color: accentGlow(Theme.brandAccent), radius: …)`
    /// to make an accent-filled element appear lit from within.
    static func accentGlow(_ color: Color, opacity: Double = 0.45) -> Color {
        color.opacity(opacity)
    }
}

/// Floating glass card: adaptive material base, frost layer, top sheen, a
/// 0.75pt specular border, and a drop shadow that lifts it off the backdrop.
/// Light mode adds a dark outer definition line so edges read against the
/// light material; dark mode keeps the original sheen-only recipe.
struct GlassCard: ViewModifier {
    var cornerRadius: CGFloat = 12
    @Environment(\.colorScheme) private var colorScheme

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        let shadow = Glass.cardShadow(for: colorScheme)
        content
            .background {
                ZStack {
                    shape.fill(.ultraThinMaterial)
                    shape.fill(Glass.cardFill(for: colorScheme))
                    Glass.topSheen(for: colorScheme).clipShape(shape)
                }
                .compositingGroup()
                .shadow(color: shadow.color, radius: shadow.radius, y: shadow.y)
            }
            .overlay(shape.strokeBorder(Glass.specularBorder(for: colorScheme), lineWidth: 0.75))
            .overlay {
                if colorScheme == .light {
                    // Definition line just outside the bright rim -- without it
                    // the card edge dissolves into the light backdrop.
                    shape.inset(by: -0.5).stroke(Color.black.opacity(0.10), lineWidth: 0.5)
                }
            }
    }
}

extension View {
    /// Wraps the view in a liquid-glass card. See `GlassCard`.
    func glassCard(cornerRadius: CGFloat = 12) -> some View {
        modifier(GlassCard(cornerRadius: cornerRadius))
    }
}

extension Font {
    /// SF Mono for currency values -- developer-tool identity.
    static func codeMono(size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }
}
