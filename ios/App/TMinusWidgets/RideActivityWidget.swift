import ActivityKit
import SwiftUI
import WidgetKit

// The tracked ride's Live Activity: the Lock Screen card and the Dynamic Island.
struct RideActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RideAttributes.self) { context in
            LockScreen(tripName: context.attributes.tripName, state: context.state)
        } dynamicIsland: { context in
            DynamicIsland {
                // A leave or walk card: the trip name and "T-Minus" (the route and the countdown are in
                // its body); the ride card: the compact parts.
                DynamicIslandExpandedRegion(.leading) {
                    if context.state.head != nil { IslandTop(text: context.attributes.tripName) } else { IslandLeading(state: context.state) }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if context.state.head != nil { IslandTop(text: "T-Minus") } else { IslandTrailing(state: context.state) }
                }
                DynamicIslandExpandedRegion(.bottom) { IslandExpanded(state: context.state) }
            } compactLeading: {
                IslandLeading(state: context.state)
            } compactTrailing: {
                IslandTrailing(state: context.state)
            } minimal: {
                if context.state.color.isEmpty { Text(context.state.label) } else { RouteDot(hex: context.state.color, size: 10) }
            }
            // Expanded: wider margins than the default, so the island's rounded corners don't clip
            // the route label (top left) or the last line and the legs bar (bottom corners).
            .contentMargins(.horizontal, 24, for: .expanded)
            .contentMargins(.top, 14, for: .expanded)
            .contentMargins(.bottom, 18, for: .expanded)
        }
    }
}

private struct LockScreen: View {
    let tripName: String
    let state: RideState
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        RideCardView(tripName: tripName, state: state)
            .activityBackgroundTint(Theme.of(scheme).card)
            .activitySystemActionForegroundColor(Theme.of(scheme).text)
    }
}

@main
struct TMinusWidgets: WidgetBundle {
    var body: some Widget {
        RideActivityWidget()
        LeaveWidget()
    }
}
