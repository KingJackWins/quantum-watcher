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

/// Liquid-glass design system. Low-opacity white overlays read as "sheen" over
/// adaptive materials in both light and dark mode, so every token here is
/// appearance-agnostic by construction.
@MainActor
enum Glass {
    /// Simulates light catching the top-leading edge of a pane of glass:
    /// bright at top-left, falling off through the middle, with a faint
    /// bounce-light on the bottom-trailing edge.
    static let specularBorder = LinearGradient(
        stops: [
            .init(color: .white.opacity(0.28), location: 0.0),
            .init(color: .white.opacity(0.06), location: 0.5),
            .init(color: .white.opacity(0.12), location: 1.0),
        ],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )

    /// Frost layer painted over the material so cards feel solid, not hollow.
    static let cardFill = Color.white.opacity(0.05)

    /// Soft vertical sheen across the top ~40% of a card -- the "light from
    /// above" that makes the surface read as curved glass.
    static let topSheen = LinearGradient(
        colors: [Color.white.opacity(0.10), .clear],
        startPoint: .top,
        endPoint: UnitPoint(x: 0.5, y: 0.45)
    )

    /// Accent glow pattern: apply as `.shadow(color: accentGlow(Theme.brandAccent), radius: …)`
    /// to make an accent-filled element appear lit from within.
    static func accentGlow(_ color: Color, opacity: Double = 0.45) -> Color {
        color.opacity(opacity)
    }
}

/// Floating glass card: adaptive material base, frost layer, top sheen, a
/// 0.75pt specular border, and a drop shadow that lifts it off the backdrop.
struct GlassCard: ViewModifier {
    var cornerRadius: CGFloat = 12

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        content
            .background {
                ZStack {
                    shape.fill(.ultraThinMaterial)
                    shape.fill(Color.white.opacity(0.04))
                    Glass.topSheen.clipShape(shape)
                }
                .compositingGroup()
                .shadow(color: .black.opacity(0.18), radius: 10, y: 5)
            }
            .overlay(shape.strokeBorder(Glass.specularBorder, lineWidth: 0.75))
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
