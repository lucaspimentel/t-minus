import ActivityKit

// A tracked ride's Live Activity (the app's TMinusPlugin starts it; the server pushes updates).
struct RideAttributes: ActivityAttributes {
    typealias ContentState = RideState
    var tripName: String
}
