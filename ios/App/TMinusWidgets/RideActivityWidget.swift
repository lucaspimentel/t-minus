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
                DynamicIslandExpandedRegion(.leading) { IslandLeading(state: context.state) }
                DynamicIslandExpandedRegion(.trailing) { IslandTrailing(state: context.state) }
                DynamicIslandExpandedRegion(.bottom) { IslandExpanded(state: context.state) }
            } compactLeading: {
                IslandLeading(state: context.state)
            } compactTrailing: {
                IslandTrailing(state: context.state)
            } minimal: {
                if context.state.color.isEmpty { Text(context.state.label) } else { RouteDot(hex: context.state.color, size: 10) }
            }
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
    }
}
