import ActivityKit

// A tracked ride's Live Activity (the app's TMinusPlugin starts it; the server pushes updates),
// or a reminder's leave card (the server starts it by push: `reminderId` set; its push
// `attributes` are these fields by name).
struct RideAttributes: ActivityAttributes {
    typealias ContentState = RideState
    var tripName: String
    var reminderId: String? = nil
}
