//! What the source says the legal maximum speed on a road is.
//!
//! These are Atlas's own semantics for a speed limit, derived by an input
//! adapter from whatever the source format happens to call things. As with
//! direction and access, the kernel must not learn what a `maxspeed` tag is,
//! only what a speed-limit fact means.
//!
//! Four things shape this module, and every one of them is a distinction that
//! is easy to lose and expensive to get back.
//!
//! **A legal maximum is not a travel speed.** `50 km/h` is the fastest the law
//! allows, not how fast anybody actually moves. A road may be signed at
//! 50 km/h and be impassable; a road with no limit at all may be crawling.
//! Nothing here estimates a travel speed, and nothing here may be read as one.
//!
//! **A speed is not an access rule and not a direction.** A road prohibited to
//! motorcars can still carry a motorcar speed limit, because the sign is on
//! the post whether or not anyone may drive past it. A reverse one-way can
//! carry both a forward and a backward limit, because the source is describing
//! the road, not the traffic. Speed, access, direction and classification are
//! four independent records on [`crate::FeatureKind::Road`], and none of them
//! is derived from another.
//!
//! **Forward and backward are relative to the geometry.** [`SpeedDirection`]
//! means "along" or "against the coordinate order of the line", exactly as
//! [`crate::TravelDirection`] does. Reversing a geometry would reverse the
//! meaning of every speed fact attached to it, which is one more reason Atlas
//! never reverses a geometry.
//!
//! **A magnitude is exact and its unit is preserved.** `30 mph` is stored as
//! thirty miles per hour, not as 48.28 km/h and not as an `f64`. Converting
//! would throw away what the source said and introduce a rounding error into
//! a legal fact; storing a float would make two imports of the same file
//! capable of disagreeing. A routing layer may convert later, when it knows
//! what it wants the number for.

use std::cmp::Ordering;
use std::fmt;

use crate::traversal::TravelMode;

/// Everything that can go wrong while constructing a speed value.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SpeedError {
    /// The magnitude was empty, or nothing but a decimal point.
    #[error("a speed magnitude must contain at least one digit")]
    BlankMagnitude,
    /// The magnitude was not a plain unsigned decimal number.
    ///
    /// Signs, exponents, comma decimals, thousands separators, several decimal
    /// points and any other text are all refused rather than guessed at.
    #[error("`{value}` is not a plain unsigned decimal magnitude")]
    MalformedMagnitude {
        /// The rejected text, exactly as it was offered.
        value: String,
    },
    /// An implicit speed code did not have the documented shape.
    #[error("`{value}` is not a `COUNTRY[-REGION]:context` speed code")]
    MalformedImplicitCode {
        /// The rejected text, exactly as it was offered.
        value: String,
    },
}

/// The unit a speed magnitude is stated in.
///
/// A closed set of the three canonical units, and deliberately no conversion
/// between them. The unit is part of what the source said; dropping it, or
/// normalising every value to one unit, would replace a fact with an
/// arithmetic result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SpeedUnit {
    /// Kilometres per hour, the unit a unitless source value means.
    KilometresPerHour,
    /// Miles per hour.
    MilesPerHour,
    /// Knots.
    Knots,
}

impl SpeedUnit {
    /// Every unit Atlas models, in a stable order.
    pub const ALL: [SpeedUnit; 3] = [
        SpeedUnit::KilometresPerHour,
        SpeedUnit::MilesPerHour,
        SpeedUnit::Knots,
    ];

    /// The canonical, stable wire form of the unit.
    pub fn as_str(self) -> &'static str {
        match self {
            SpeedUnit::KilometresPerHour => "km/h",
            SpeedUnit::MilesPerHour => "mph",
            SpeedUnit::Knots => "knots",
        }
    }
}

impl fmt::Display for SpeedUnit {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// An exact speed magnitude in a stated unit.
///
/// The magnitude is held as a validated canonical decimal string rather than
/// as a float. Two reasons, and both of them are about being able to trust the
/// value later:
///
/// * **Exactness.** `50.5` is `50.5`, not `50.49999999999999289457264239899814`.
///   A legal limit is a number somebody wrote on a sign, and Atlas repeats it.
/// * **Determinism.** Equality, ordering, hashing and formatting are all
///   decided by the canonical digits, so two imports of one file produce
///   values that are equal, sort the same way and serialise byte for byte the
///   same. Float equality could not promise any of that.
///
/// Canonicalisation strips what carries no information and nothing else:
/// `050.500` becomes `50.5`, `0.0` becomes `0`, `.5` becomes `0.5`. It never
/// rounds, never rescales and never changes the unit.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Speed {
    /// Canonical decimal digits: `[0-9]+` optionally followed by `.[0-9]+`,
    /// with no sign, no exponent, no redundant leading zero and no redundant
    /// trailing fractional zero.
    magnitude: String,
    unit: SpeedUnit,
}

impl Speed {
    /// Builds a speed, validating and canonicalising the magnitude.
    ///
    /// Accepts ASCII digits with at most one decimal point, and refuses
    /// everything else — including the blank value that a `<tag k="maxspeed"/>`
    /// arrives as. Raw source text must not reach this type unchecked, which
    /// is why there is no infallible constructor.
    pub fn new(magnitude: &str, unit: SpeedUnit) -> Result<Self, SpeedError> {
        Ok(Self {
            magnitude: canonical_decimal(magnitude)?,
            unit,
        })
    }

    /// The exact magnitude, in canonical decimal form.
    ///
    /// A string, not a number, because that is what exactness costs. A caller
    /// that genuinely needs arithmetic parses it knowingly.
    pub fn magnitude(&self) -> &str {
        &self.magnitude
    }

    /// The unit the magnitude is stated in, exactly as the source stated it.
    pub fn unit(&self) -> SpeedUnit {
        self.unit
    }

    /// Whether the magnitude is exactly zero.
    ///
    /// Zero is a legal thing for a source to say and is kept as a number, not
    /// folded into some "no limit" or "unknown" bucket.
    pub fn is_zero(&self) -> bool {
        self.magnitude == "0"
    }
}

impl fmt::Display for Speed {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} {}", self.magnitude, self.unit)
    }
}

impl PartialOrd for Speed {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// A total order over speeds, for deterministic collections — **not** a
/// comparison of how fast two roads are.
///
/// Units are compared first, in [`SpeedUnit::ALL`] order, and magnitudes only
/// within one unit. That is on purpose: ranking `30 mph` against `40 km/h`
/// would require a conversion, and this milestone does not convert. Within a
/// unit the order is numeric rather than lexicographic, so `9` sorts below
/// `100` as a reader would expect.
impl Ord for Speed {
    fn cmp(&self, other: &Self) -> Ordering {
        self.unit
            .cmp(&other.unit)
            .then_with(|| compare_canonical_decimals(&self.magnitude, &other.magnitude))
    }
}

/// Validates and canonicalises an unsigned decimal magnitude.
fn canonical_decimal(raw: &str) -> Result<String, SpeedError> {
    if raw.is_empty() {
        return Err(SpeedError::BlankMagnitude);
    }

    let malformed = || SpeedError::MalformedMagnitude {
        value: raw.to_owned(),
    };

    let (integer, fraction) = match raw.split_once('.') {
        Some((integer, fraction)) => {
            // A second decimal point makes the text ambiguous, not roundable.
            if fraction.contains('.') {
                return Err(malformed());
            }
            (integer, fraction)
        }
        None => (raw, ""),
    };

    if !integer.bytes().all(|byte| byte.is_ascii_digit())
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(malformed());
    }
    if integer.is_empty() && fraction.is_empty() {
        return Err(SpeedError::BlankMagnitude);
    }

    let integer = integer.trim_start_matches('0');
    let integer = if integer.is_empty() { "0" } else { integer };
    let fraction = fraction.trim_end_matches('0');

    Ok(if fraction.is_empty() {
        integer.to_owned()
    } else {
        format!("{integer}.{fraction}")
    })
}

/// Orders two canonical decimals numerically.
///
/// Canonical form does the hard part: with no redundant leading zeroes, a
/// longer integer part is always the larger number, and equal lengths compare
/// digit by digit. The fractions then compare left to right, with a missing
/// digit reading as zero.
fn compare_canonical_decimals(left: &str, right: &str) -> Ordering {
    let (left_integer, left_fraction) = split_canonical(left);
    let (right_integer, right_fraction) = split_canonical(right);

    left_integer
        .len()
        .cmp(&right_integer.len())
        .then_with(|| left_integer.cmp(right_integer))
        .then_with(|| {
            let width = left_fraction.len().max(right_fraction.len());
            for index in 0..width {
                let left_digit = left_fraction.as_bytes().get(index).copied().unwrap_or(b'0');
                let right_digit = right_fraction
                    .as_bytes()
                    .get(index)
                    .copied()
                    .unwrap_or(b'0');
                match left_digit.cmp(&right_digit) {
                    Ordering::Equal => {}
                    other => return other,
                }
            }
            Ordering::Equal
        })
}

fn split_canonical(value: &str) -> (&str, &str) {
    value.split_once('.').unwrap_or((value, ""))
}

/// A jurisdiction's implicit speed-limit code, carried by the limit itself.
///
/// Some sources state the limit by naming the rule that applies rather than
/// the number it produces: `RO:urban`, `GB:nsl_single`, `GB-WLS:nsl_restricted`.
/// Atlas preserves the normalised code and **does not resolve it to a number**.
/// Resolving it would mean shipping a table of every country's default limits,
/// keeping that table current, and knowing which edition of the law a given
/// extract was surveyed under — a country-defaults feature that is deliberately
/// not part of this milestone.
///
/// The context may narrow more than once. The source documents values such as
/// `AR:urban:primary` and `DE:zone:30`, where a jurisdiction's rule is further
/// qualified by a road class or a zone. Atlas keeps every component and the
/// colon structure between them: the components are what the rule *is*, and
/// dropping or flattening them would record a different rule from the one the
/// mapper named.
///
/// Normalisation is case only: the country and region are upper-cased and
/// every context component is lower-cased, so `ar:URBAN:Primary` and
/// `AR:urban:primary` are one code. Nothing about the meaning is touched.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ImplicitSpeedCode(String);

impl ImplicitSpeedCode {
    /// Builds a code, validating its `COUNTRY[-REGION]:segment[:segment...]`
    /// shape.
    ///
    /// The country is two ASCII letters, an optional region is one to three
    /// ASCII alphanumerics after a hyphen, and the context is one or more
    /// colon-separated components, each one or more ASCII alphanumerics or
    /// underscores. Anything else is refused: an unvalidated code would be raw
    /// source text wearing a domain type's name.
    ///
    /// Accepting *more* components is not accepting *missing* ones. An empty
    /// component names nothing, so `RO::urban`, `RO:urban:` and
    /// `RO:urban::extra` stay malformed.
    pub fn new(value: &str) -> Result<Self, SpeedError> {
        let malformed = || SpeedError::MalformedImplicitCode {
            value: value.to_owned(),
        };

        let (jurisdiction, context) = value.split_once(':').ok_or_else(malformed)?;
        // `split(':')` yields an empty component for a leading, trailing or
        // doubled colon, so requiring every component to be non-empty is the
        // whole guard against them.
        if !context.split(':').all(|component| {
            !component.is_empty()
                && component
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        }) {
            return Err(malformed());
        }

        let (country, region) = match jurisdiction.split_once('-') {
            Some((country, region)) => (country, Some(region)),
            None => (jurisdiction, None),
        };
        if country.len() != 2 || !country.bytes().all(|byte| byte.is_ascii_alphabetic()) {
            return Err(malformed());
        }
        if let Some(region) = region
            && (region.is_empty()
                || region.len() > 3
                || !region.bytes().all(|byte| byte.is_ascii_alphanumeric()))
        {
            return Err(malformed());
        }

        let jurisdiction = jurisdiction.to_ascii_uppercase();
        // Lower-casing the whole context at once reaches every component and
        // leaves the colons between them alone.
        let context = context.to_ascii_lowercase();
        Ok(Self(format!("{jurisdiction}:{context}")))
    }

    /// The normalised code, for example `GB-WLS:nsl_restricted` or
    /// `AR:urban:primary`.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ImplicitSpeedCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// The ordinary, static legal maximum one mode faces in one direction.
///
/// "Ordinary" is the operative word. A conditional limit and a variable-sign
/// declaration are modifiers *on* this value, not alternatives *to* it, and
/// they live in [`SpeedLimitFact`] beside it rather than as variants here. A
/// road signed at 80 with a wet-weather limit of 60 still has an ordinary
/// limit of 80, and a client that only understood a `Conditional` variant
/// would have lost the 80 entirely.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SpeedLimitValue {
    /// No applicable explicit normal limit was present.
    ///
    /// The absence of a statement, and emphatically not "unlimited" and not
    /// "whatever this country's default is". Only this variant can later be
    /// improved by a survey or resolved by a country-defaults table.
    Unspecified,
    /// An exact magnitude in the unit the source stated it in.
    Numeric(Speed),
    /// The source says there is no fixed limit, such as a German autobahn.
    ///
    /// This is knowledge, not the lack of it: somebody looked and recorded
    /// that no number applies. It is not [`SpeedLimitValue::Unspecified`] and
    /// it is certainly not [`SpeedLimitValue::Indeterminate`].
    NoFixedLimit,
    /// The source says the limit is walking pace.
    ///
    /// Kept as a named fact rather than converted to a guessed number. Walking
    /// pace is not 5 km/h or 7 km/h in law; it is walking pace, and inventing
    /// a figure would put Atlas's guess where a legal limit belongs.
    WalkingPace,
    /// The limit is whatever a named jurisdiction rule says it is.
    ///
    /// The code is preserved; the number it implies is not derived. See
    /// [`ImplicitSpeedCode`].
    Implicit(ImplicitSpeedCode),
    /// A relevant value existed and Atlas could not read it safely.
    ///
    /// A refusal to guess, not a default. It is what Atlas records when the
    /// source states a limit in a form it cannot parse, in a unit it does not
    /// support, or with a value that is not a recognised correct one.
    Indeterminate,
}

impl SpeedLimitValue {
    /// The stable wire form of the variant's kind.
    ///
    /// The kind alone, without the magnitude, unit or code — those are
    /// separate members at the wire boundary.
    pub fn kind(&self) -> &'static str {
        match self {
            SpeedLimitValue::Unspecified => "unspecified",
            SpeedLimitValue::Numeric(_) => "numeric",
            SpeedLimitValue::NoFixedLimit => "no-fixed-limit",
            SpeedLimitValue::WalkingPace => "walking-pace",
            SpeedLimitValue::Implicit(_) => "implicit",
            SpeedLimitValue::Indeterminate => "indeterminate",
        }
    }

    /// Whether the source stated anything at all about this limit.
    ///
    /// A question about the *record*, not about the road: `false` means Atlas
    /// found no applicable tag. It is not "may a vehicle go fast here", which
    /// is a routing question Atlas does not answer.
    pub fn is_stated(&self) -> bool {
        !matches!(self, SpeedLimitValue::Unspecified)
    }

    /// The exact speed, when the limit is a number.
    pub fn speed(&self) -> Option<&Speed> {
        match self {
            SpeedLimitValue::Numeric(speed) => Some(speed),
            _ => None,
        }
    }

    /// The jurisdiction code, when the limit is an implicit one.
    pub fn implicit_code(&self) -> Option<&ImplicitSpeedCode> {
        match self {
            SpeedLimitValue::Implicit(code) => Some(code),
            _ => None,
        }
    }
}

/// Whether a conditional limit supplements the ordinary one.
///
/// Atlas detects the presence of a conditional statement and deliberately does
/// not evaluate it: reading `60 @ wet` honestly would need a weather model and
/// a clock, and recording a rainy-Tuesday limit as a permanent fact would be
/// worse than saying nothing. Presence is the whole claim.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ConditionalSpeedLimit {
    /// Atlas found no applicable conditional statement.
    ///
    /// A statement about the source record, not a promise that the limit never
    /// changes.
    NotTagged,
    /// A conditional statement applies and Atlas has not evaluated it.
    Present,
}

impl ConditionalSpeedLimit {
    /// Every value, in a stable order.
    pub const ALL: [ConditionalSpeedLimit; 2] = [
        ConditionalSpeedLimit::NotTagged,
        ConditionalSpeedLimit::Present,
    ];

    /// The stable wire form.
    pub fn as_str(self) -> &'static str {
        match self {
            ConditionalSpeedLimit::NotTagged => "not-tagged",
            ConditionalSpeedLimit::Present => "present",
        }
    }

    /// Whether a conditional statement applies.
    pub fn is_present(self) -> bool {
        matches!(self, ConditionalSpeedLimit::Present)
    }
}

impl fmt::Display for ConditionalSpeedLimit {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Whether the source says the limit is displayed by a variable sign.
///
/// Another modifier, and another thing that is not a limit. A variable-sign
/// road still has an ordinary limit; the declaration says that the number on
/// the gantry can differ from it. Whether a particular traveller is bound by
/// the gantry is a routing-policy question Atlas does not answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum VariableSpeedLimit {
    /// Atlas found no applicable variability statement.
    NotTagged,
    /// The source explicitly says the limit does *not* vary.
    ///
    /// Distinct from [`VariableSpeedLimit::NotTagged`]: somebody checked and
    /// said so.
    Fixed,
    /// The source says the limit varies, optionally naming why.
    Variable,
    /// A variability statement existed and Atlas could not read it.
    Indeterminate,
}

impl VariableSpeedLimit {
    /// Every value, in a stable order.
    pub const ALL: [VariableSpeedLimit; 4] = [
        VariableSpeedLimit::NotTagged,
        VariableSpeedLimit::Fixed,
        VariableSpeedLimit::Variable,
        VariableSpeedLimit::Indeterminate,
    ];

    /// The stable wire form.
    pub fn as_str(self) -> &'static str {
        match self {
            VariableSpeedLimit::NotTagged => "not-tagged",
            VariableSpeedLimit::Fixed => "fixed",
            VariableSpeedLimit::Variable => "variable",
            VariableSpeedLimit::Indeterminate => "indeterminate",
        }
    }

    /// Whether the source stated anything about variability at all.
    pub fn is_stated(self) -> bool {
        !matches!(self, VariableSpeedLimit::NotTagged)
    }
}

impl fmt::Display for VariableSpeedLimit {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Everything the source says about one mode's limit in one direction.
///
/// Three independent members, not one value with qualifiers. The ordinary
/// limit stands on its own; the two modifiers say what else the source
/// attached to it. A conditional never erases the ordinary limit, and neither
/// does a variability declaration.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SpeedLimitFact {
    limit: SpeedLimitValue,
    conditional: ConditionalSpeedLimit,
    variable: VariableSpeedLimit,
}

impl SpeedLimitFact {
    /// Builds a fact from an ordinary limit and its two modifiers.
    ///
    /// Infallible: there is no invariant between the three. Every combination
    /// is one a source can genuinely state, including an unspecified ordinary
    /// limit with a conditional present — a road where the only thing anybody
    /// tagged is the exception.
    pub fn new(
        limit: SpeedLimitValue,
        conditional: ConditionalSpeedLimit,
        variable: VariableSpeedLimit,
    ) -> Self {
        Self {
            limit,
            conditional,
            variable,
        }
    }

    /// The fact recorded for a road whose source said nothing about speed.
    ///
    /// Deliberately a named constructor and not a `Default` impl, for the same
    /// reason [`crate::RoadAccess::unspecified`] is: "the source said nothing"
    /// is a claim about a source, and a half-built feature or an older adapter
    /// must not be able to make it by accident.
    pub fn unspecified() -> Self {
        Self::new(
            SpeedLimitValue::Unspecified,
            ConditionalSpeedLimit::NotTagged,
            VariableSpeedLimit::NotTagged,
        )
    }

    /// Builds a fact carrying only an ordinary limit, with neither modifier.
    pub fn plain(limit: SpeedLimitValue) -> Self {
        Self::new(
            limit,
            ConditionalSpeedLimit::NotTagged,
            VariableSpeedLimit::NotTagged,
        )
    }

    /// The ordinary, static limit.
    pub fn limit(&self) -> &SpeedLimitValue {
        &self.limit
    }

    /// Whether a conditional limit supplements the ordinary one.
    pub fn conditional(&self) -> ConditionalSpeedLimit {
        self.conditional
    }

    /// What the source says about the limit varying.
    pub fn variable(&self) -> VariableSpeedLimit {
        self.variable
    }

    /// Whether the source said anything at all about this direction's speed.
    pub fn is_stated(&self) -> bool {
        self.limit.is_stated() || self.conditional.is_present() || self.variable.is_stated()
    }
}

/// Which way along a road's geometry a speed fact applies.
///
/// Relative to the coordinate order of the line, never to the compass and
/// never to a permitted direction of travel: a two-way road has a forward and
/// a backward limit, and so does a road nobody may drive at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SpeedDirection {
    /// Along the coordinate order of the line.
    Forward,
    /// Against the coordinate order of the line.
    Backward,
}

impl SpeedDirection {
    /// Both directions, in a stable order.
    pub const ALL: [SpeedDirection; 2] = [SpeedDirection::Forward, SpeedDirection::Backward];

    /// The stable wire form.
    pub fn as_str(self) -> &'static str {
        match self {
            SpeedDirection::Forward => "forward",
            SpeedDirection::Backward => "backward",
        }
    }
}

impl fmt::Display for SpeedDirection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// One mode's speed facts, one per geometry direction.
///
/// Always complete: both directions have an answer, so no consumer has to
/// invent one. The two are independent — a source may sign only one direction
/// — and neither says whether the mode may travel that way.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct DirectionalSpeedLimits {
    forward: SpeedLimitFact,
    backward: SpeedLimitFact,
}

impl DirectionalSpeedLimits {
    /// Builds a directional record from one fact per direction.
    pub fn new(forward: SpeedLimitFact, backward: SpeedLimitFact) -> Self {
        Self { forward, backward }
    }

    /// Builds a record that is the same in both directions.
    pub fn uniform(fact: SpeedLimitFact) -> Self {
        Self::new(fact.clone(), fact)
    }

    /// The record of a road whose source said nothing about speed.
    ///
    /// Named rather than a `Default`, for the reason given on
    /// [`SpeedLimitFact::unspecified`].
    pub fn unspecified() -> Self {
        Self::uniform(SpeedLimitFact::unspecified())
    }

    /// The fact for one geometry direction.
    pub fn fact(&self, direction: SpeedDirection) -> &SpeedLimitFact {
        match direction {
            SpeedDirection::Forward => &self.forward,
            SpeedDirection::Backward => &self.backward,
        }
    }

    /// The fact along the coordinate order of the line.
    pub fn forward(&self) -> &SpeedLimitFact {
        &self.forward
    }

    /// The fact against the coordinate order of the line.
    pub fn backward(&self) -> &SpeedLimitFact {
        &self.backward
    }

    /// Whether the source said anything about either direction.
    pub fn is_stated(&self) -> bool {
        self.forward.is_stated() || self.backward.is_stated()
    }
}

/// The speed-limit facts a road carries, per mode and per direction.
///
/// Immutable, and always complete: six facts, one for each modelled mode in
/// each geometry direction, so a consumer never has to guess at a combination
/// the source was silent about. Silence is [`SpeedLimitValue::Unspecified`],
/// which says exactly that and nothing more.
///
/// This record sits beside [`crate::RoadClass`], [`crate::RoadTraversal`] and
/// [`crate::RoadAccess`] on [`crate::FeatureKind::Road`] and is independent of
/// all three. A prohibited road may carry a limit; a one-way road carries both
/// directions' limits; a motorway's class implies nothing here.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RoadSpeedLimits {
    motorcar: DirectionalSpeedLimits,
    bicycle: DirectionalSpeedLimits,
    foot: DirectionalSpeedLimits,
}

impl RoadSpeedLimits {
    /// Builds a speed record from one directional record per mode.
    ///
    /// Infallible on purpose: the three modes are independent, and every
    /// combination — including a bicycle limit on a road with no car limit —
    /// is one a source can state.
    pub fn new(
        motorcar: DirectionalSpeedLimits,
        bicycle: DirectionalSpeedLimits,
        foot: DirectionalSpeedLimits,
    ) -> Self {
        Self {
            motorcar,
            bicycle,
            foot,
        }
    }

    /// Builds a record that is the same for every mode.
    pub fn uniform(limits: DirectionalSpeedLimits) -> Self {
        Self::new(limits.clone(), limits.clone(), limits)
    }

    /// The speed record of a road whose source said nothing about speed.
    ///
    /// Deliberately a named constructor and not a `Default` impl. A default
    /// would let a half-built feature, a forgotten field or an older adapter
    /// claim that a source was silent about speed without ever having read it,
    /// and the result would be indistinguishable from a real import that
    /// looked and found nothing.
    pub fn unspecified() -> Self {
        Self::uniform(DirectionalSpeedLimits::unspecified())
    }

    /// The directional record for one mode.
    ///
    /// Consumers ask by mode rather than by field, so that adding a mode later
    /// does not mean rewriting every caller's `match`.
    pub fn limits(&self, mode: TravelMode) -> &DirectionalSpeedLimits {
        match mode {
            TravelMode::Motorcar => &self.motorcar,
            TravelMode::Bicycle => &self.bicycle,
            TravelMode::Foot => &self.foot,
        }
    }

    /// The fact for one mode in one geometry direction.
    pub fn fact(&self, mode: TravelMode, direction: SpeedDirection) -> &SpeedLimitFact {
        self.limits(mode).fact(direction)
    }

    /// The directional record for a motorcar.
    pub fn motorcar(&self) -> &DirectionalSpeedLimits {
        &self.motorcar
    }

    /// The directional record for a bicycle.
    pub fn bicycle(&self) -> &DirectionalSpeedLimits {
        &self.bicycle
    }

    /// The directional record for a pedestrian.
    pub fn foot(&self) -> &DirectionalSpeedLimits {
        &self.foot
    }

    /// Whether the source said anything about speed for any mode.
    pub fn is_stated(&self) -> bool {
        TravelMode::ALL
            .iter()
            .any(|mode| self.limits(*mode).is_stated())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::collections::BTreeSet;

    use SpeedUnit::{KilometresPerHour, Knots, MilesPerHour};

    fn kmh(magnitude: &str) -> Speed {
        Speed::new(magnitude, KilometresPerHour).expect("a valid magnitude")
    }

    fn numeric(magnitude: &str, unit: SpeedUnit) -> SpeedLimitValue {
        SpeedLimitValue::Numeric(Speed::new(magnitude, unit).expect("a valid magnitude"))
    }

    // -- units --------------------------------------------------------------

    #[test]
    fn every_unit_has_a_stable_wire_form() {
        let wire: Vec<&str> = SpeedUnit::ALL.iter().map(|unit| unit.as_str()).collect();
        assert_eq!(wire, vec!["km/h", "mph", "knots"]);
        for unit in SpeedUnit::ALL {
            assert_eq!(unit.to_string(), unit.as_str());
        }
        let distinct: BTreeSet<&str> = wire.into_iter().collect();
        assert_eq!(distinct.len(), SpeedUnit::ALL.len());
    }

    #[test]
    fn every_unit_variant_is_covered_by_all() {
        // A fourth unit added without extending `ALL` fails here rather than
        // quietly disappearing from every test that iterates over it.
        for unit in SpeedUnit::ALL {
            let round_trip = match unit {
                SpeedUnit::KilometresPerHour => "km/h",
                SpeedUnit::MilesPerHour => "mph",
                SpeedUnit::Knots => "knots",
            };
            assert_eq!(unit.as_str(), round_trip);
        }
        assert_eq!(SpeedUnit::ALL.len(), 3);
    }

    // -- magnitudes ---------------------------------------------------------

    #[test]
    fn magnitudes_are_canonicalised_without_rounding() {
        for (raw, canonical) in [
            ("50", "50"),
            ("050.500", "50.5"),
            ("0.0", "0"),
            ("0", "0"),
            ("000", "0"),
            ("00.00", "0"),
            (".5", "0.5"),
            ("5.", "5"),
            ("30.0", "30"),
            ("7.25", "7.25"),
            ("0.125", "0.125"),
            ("100", "100"),
            ("0007", "7"),
            ("12.340", "12.34"),
            ("1000000.000001", "1000000.000001"),
        ] {
            let speed = kmh(raw);
            assert_eq!(speed.magnitude(), canonical, "{raw} canonicalises wrong");
            // Canonicalising a canonical value changes nothing.
            assert_eq!(kmh(canonical).magnitude(), canonical);
        }
    }

    #[test]
    fn canonical_magnitudes_never_carry_a_sign_exponent_or_redundant_zero() {
        for raw in ["050.500", "0.0", ".5", "000", "12.340"] {
            let magnitude = kmh(raw).magnitude().to_owned();
            assert!(
                !magnitude.contains('+') && !magnitude.contains('-'),
                "{raw}"
            );
            assert!(
                !magnitude.contains('e') && !magnitude.contains('E'),
                "{raw}"
            );
            assert!(!magnitude.ends_with('.'), "{raw}");
            assert!(!magnitude.ends_with('0') || magnitude == "0" || !magnitude.contains('.'));
            assert!(
                magnitude == "0" || !magnitude.starts_with('0') || magnitude.starts_with("0."),
                "{magnitude} kept a redundant leading zero"
            );
        }
    }

    #[test]
    fn malformed_magnitudes_are_refused_rather_than_guessed_at() {
        assert_eq!(
            Speed::new("", KilometresPerHour),
            Err(SpeedError::BlankMagnitude)
        );
        assert_eq!(
            Speed::new(".", KilometresPerHour),
            Err(SpeedError::BlankMagnitude)
        );
        for raw in [
            "-50",    // a negative limit is not a thing
            "+50",    // an explicit sign is not canonical
            "5e1",    // exponent notation
            "5E1",    //
            "50,5",   // comma decimal
            "1,000",  // thousands separator
            "50.5.5", // several decimal points
            "50 ",    // the adapter trims; the kernel does not
            " 50",    //
            "fifty",  //
            "50kmh",  // a unit belongs in `SpeedUnit`, not the magnitude
            "٥٠",     // non-ASCII digits
            "50\u{200b}",
            "NaN",
            "inf",
        ] {
            assert_eq!(
                Speed::new(raw, KilometresPerHour),
                Err(SpeedError::MalformedMagnitude {
                    value: raw.to_owned()
                }),
                "{raw} should be refused"
            );
        }
    }

    #[test]
    fn zero_is_a_speed_a_source_may_state() {
        let zero = kmh("0.0");
        assert!(zero.is_zero());
        assert_eq!(zero.magnitude(), "0");
        assert!(!kmh("0.1").is_zero());
        assert_eq!(zero.to_string(), "0 km/h");
    }

    #[test]
    fn a_speed_keeps_the_unit_the_source_stated() {
        // No conversion, anywhere. `30 mph` stays thirty miles per hour.
        let mph = Speed::new("30", MilesPerHour).expect("valid");
        assert_eq!(mph.magnitude(), "30");
        assert_eq!(mph.unit(), MilesPerHour);
        assert_eq!(mph.to_string(), "30 mph");
        assert_ne!(mph, Speed::new("30", KilometresPerHour).expect("valid"));
        assert_eq!(
            Speed::new("10", Knots).expect("valid").to_string(),
            "10 knots"
        );
    }

    #[test]
    fn equality_and_hashing_follow_the_canonical_digits() {
        use std::collections::HashSet;

        assert_eq!(kmh("050.500"), kmh("50.5"));
        assert_eq!(kmh("0.0"), kmh("0"));

        let mut set = HashSet::new();
        set.insert(kmh("050.500"));
        assert!(set.contains(&kmh("50.5")));
        assert!(!set.contains(&kmh("50.50001")));
        set.insert(kmh("50.5"));
        assert_eq!(set.len(), 1);
    }

    #[test]
    fn ordering_is_numeric_within_a_unit_and_never_converts_between_units() {
        // Lexicographic ordering would put 100 below 9; numeric ordering does
        // not. This is a deterministic total order for collections, not a
        // claim about which road is faster.
        let mut speeds = [
            kmh("100"),
            kmh("9"),
            kmh("50.5"),
            kmh("50"),
            kmh("0"),
            kmh("50.45"),
        ];
        speeds.sort();
        let magnitudes: Vec<&str> = speeds.iter().map(Speed::magnitude).collect();
        assert_eq!(magnitudes, vec!["0", "9", "50", "50.45", "50.5", "100"]);

        // Units partition the order; no magnitude is ever compared across one.
        let mut mixed = [
            Speed::new("10", Knots).expect("valid"),
            Speed::new("30", MilesPerHour).expect("valid"),
            kmh("1"),
        ];
        mixed.sort();
        assert_eq!(
            mixed.iter().map(Speed::unit).collect::<Vec<_>>(),
            vec![KilometresPerHour, MilesPerHour, Knots]
        );
    }

    #[test]
    fn ordering_compares_fractions_digit_by_digit() {
        assert!(kmh("1.1") < kmh("1.11"));
        assert!(kmh("1.2") > kmh("1.11"));
        assert!(kmh("1") < kmh("1.0001"));
        assert_eq!(kmh("1.10"), kmh("1.1"));
        assert_eq!(kmh("1").cmp(&kmh("1")), Ordering::Equal);
    }

    // -- implicit codes -----------------------------------------------------

    #[test]
    fn implicit_codes_accept_the_documented_shapes() {
        for (raw, normalised) in [
            ("RO:urban", "RO:urban"),
            ("ro:URBAN", "RO:urban"),
            ("GB:nsl_single", "GB:nsl_single"),
            ("GB-WLS:nsl_restricted", "GB-WLS:nsl_restricted"),
            ("gb-wls:nsl_restricted", "GB-WLS:nsl_restricted"),
            ("DE:rural", "DE:rural"),
            ("AT:motorway", "AT:motorway"),
            ("US-MD:urban", "US-MD:urban"),
            ("DE:zone30", "DE:zone30"),
        ] {
            let code = ImplicitSpeedCode::new(raw).expect("a documented code");
            assert_eq!(code.as_str(), normalised, "{raw}");
            assert_eq!(code.to_string(), normalised);
        }
    }

    #[test]
    fn implicit_codes_accept_several_context_components() {
        // The source documents implicit values that narrow the context more
        // than once — a road class inside an urban rule, a zone inside a
        // numbered one. Refusing them would turn a valid source fact into
        // `Indeterminate` and blame the mapper for it.
        for (raw, normalised) in [
            ("AR:urban:primary", "AR:urban:primary"),
            ("DE:zone:30", "DE:zone:30"),
            ("ar:URBAN:Primary", "AR:urban:primary"),
            ("de-by:zone:30", "DE-BY:zone:30"),
            (
                "GB-WLS:nsl_restricted:single",
                "GB-WLS:nsl_restricted:single",
            ),
            ("AT:urban:motorway:tunnel", "AT:urban:motorway:tunnel"),
        ] {
            let code = ImplicitSpeedCode::new(raw).expect("a documented multi-segment code");
            assert_eq!(code.as_str(), normalised, "{raw}");
            assert_eq!(code.to_string(), normalised);
        }
    }

    #[test]
    fn case_normalisation_reaches_every_context_component() {
        // Case is the only thing normalisation touches, and it has to touch
        // all of the context, not just its first segment.
        let code = ImplicitSpeedCode::new("aR-bY:ZONE:Urban_Primary:A30").expect("a valid code");
        assert_eq!(code.as_str(), "AR-BY:zone:urban_primary:a30");
        // Two spellings of one code are one code.
        assert_eq!(
            ImplicitSpeedCode::new("AR:URBAN:PRIMARY"),
            ImplicitSpeedCode::new("ar:urban:primary")
        );
    }

    #[test]
    fn implicit_codes_refuse_an_empty_context_component() {
        // Accepting more components must not become accepting missing ones:
        // an empty segment names nothing, so there is no context to record.
        for raw in [
            "RO::urban",
            "RO:urban:",
            "RO:urban::extra",
            "RO:::",
            "RO:urban:::x",
        ] {
            assert_eq!(
                ImplicitSpeedCode::new(raw),
                Err(SpeedError::MalformedImplicitCode {
                    value: raw.to_owned()
                }),
                "{raw} should be refused"
            );
        }
    }

    #[test]
    fn implicit_codes_refuse_anything_without_a_jurisdiction_and_context() {
        for raw in [
            "urban",
            "RO:",
            ":urban",
            "R:urban",
            "ROU:urban",
            "RO-:urban",
            "RO-WALES:urban",
            // `RO:urban:extra` is a *valid* multi-segment code and moved to
            // the accepting test; an empty component is the malformed shape
            // that belongs here.
            "RO:urban::extra",
            "RO urban",
            "R1:urban",
            "RO:ur ban",
            "RO:urban-ish",
            "RO:urban:ex tra",
            "RO:urban:extra-ish",
            "",
        ] {
            assert_eq!(
                ImplicitSpeedCode::new(raw),
                Err(SpeedError::MalformedImplicitCode {
                    value: raw.to_owned()
                }),
                "{raw} should be refused"
            );
        }
    }

    // -- limit values -------------------------------------------------------

    #[test]
    fn every_limit_kind_has_a_stable_wire_form() {
        let kinds = [
            (SpeedLimitValue::Unspecified, "unspecified"),
            (numeric("50", KilometresPerHour), "numeric"),
            (SpeedLimitValue::NoFixedLimit, "no-fixed-limit"),
            (SpeedLimitValue::WalkingPace, "walking-pace"),
            (
                SpeedLimitValue::Implicit(
                    ImplicitSpeedCode::new("RO:urban").expect("a documented code"),
                ),
                "implicit",
            ),
            (SpeedLimitValue::Indeterminate, "indeterminate"),
        ];
        for (value, kind) in &kinds {
            assert_eq!(value.kind(), *kind);
            assert!(
                kind.bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte == b'-'),
                "{kind} is not lower-case kebab-case"
            );
        }
        let distinct: BTreeSet<&str> = kinds.iter().map(|(_, kind)| *kind).collect();
        assert_eq!(distinct.len(), 6);
    }

    #[test]
    fn only_unspecified_is_an_absence_of_a_statement() {
        assert!(!SpeedLimitValue::Unspecified.is_stated());
        for value in [
            numeric("50", KilometresPerHour),
            SpeedLimitValue::NoFixedLimit,
            SpeedLimitValue::WalkingPace,
            SpeedLimitValue::Implicit(ImplicitSpeedCode::new("RO:urban").expect("a code")),
            SpeedLimitValue::Indeterminate,
        ] {
            assert!(value.is_stated(), "{value:?} states something");
        }
        // None of the four non-numeric facts is a synonym for another.
        assert_ne!(SpeedLimitValue::Unspecified, SpeedLimitValue::NoFixedLimit);
        assert_ne!(SpeedLimitValue::Unspecified, SpeedLimitValue::Indeterminate);
        assert_ne!(
            SpeedLimitValue::NoFixedLimit,
            SpeedLimitValue::Indeterminate
        );
        assert_ne!(SpeedLimitValue::WalkingPace, SpeedLimitValue::NoFixedLimit);
    }

    #[test]
    fn a_limit_exposes_its_payload_only_for_the_variant_that_has_one() {
        let speed = numeric("30", MilesPerHour);
        assert_eq!(speed.speed().map(Speed::magnitude), Some("30"));
        assert_eq!(speed.speed().map(Speed::unit), Some(MilesPerHour));
        assert!(speed.implicit_code().is_none());

        let implicit =
            SpeedLimitValue::Implicit(ImplicitSpeedCode::new("GB:nsl_single").expect("a code"));
        assert_eq!(
            implicit.implicit_code().map(ImplicitSpeedCode::as_str),
            Some("GB:nsl_single")
        );
        assert!(implicit.speed().is_none());

        for value in [
            SpeedLimitValue::Unspecified,
            SpeedLimitValue::NoFixedLimit,
            SpeedLimitValue::WalkingPace,
            SpeedLimitValue::Indeterminate,
        ] {
            assert!(value.speed().is_none());
            assert!(value.implicit_code().is_none());
        }
    }

    // -- modifiers ----------------------------------------------------------

    #[test]
    fn modifier_wire_forms_are_stable_and_distinct() {
        assert_eq!(
            ConditionalSpeedLimit::ALL
                .iter()
                .map(|value| value.as_str())
                .collect::<Vec<_>>(),
            vec!["not-tagged", "present"]
        );
        assert_eq!(
            VariableSpeedLimit::ALL
                .iter()
                .map(|value| value.as_str())
                .collect::<Vec<_>>(),
            vec!["not-tagged", "fixed", "variable", "indeterminate"]
        );
        for value in ConditionalSpeedLimit::ALL {
            assert_eq!(value.to_string(), value.as_str());
        }
        for value in VariableSpeedLimit::ALL {
            assert_eq!(value.to_string(), value.as_str());
        }
    }

    #[test]
    fn not_tagged_is_a_statement_about_the_record_not_about_the_road() {
        assert!(!ConditionalSpeedLimit::NotTagged.is_present());
        assert!(ConditionalSpeedLimit::Present.is_present());
        assert!(!VariableSpeedLimit::NotTagged.is_stated());
        for value in [
            VariableSpeedLimit::Fixed,
            VariableSpeedLimit::Variable,
            VariableSpeedLimit::Indeterminate,
        ] {
            assert!(value.is_stated(), "{value} states something");
        }
        // "Nobody tagged it" and "somebody said it does not vary" are two
        // different states of knowledge.
        assert_ne!(VariableSpeedLimit::NotTagged, VariableSpeedLimit::Fixed);
    }

    #[test]
    fn a_modifier_never_replaces_the_ordinary_limit() {
        // The case the whole "modifiers are not variants" decision exists for:
        // a road signed at 80 with a wet-weather conditional still has an
        // ordinary limit of 80.
        let fact = SpeedLimitFact::new(
            numeric("80", KilometresPerHour),
            ConditionalSpeedLimit::Present,
            VariableSpeedLimit::Variable,
        );
        assert_eq!(fact.limit(), &numeric("80", KilometresPerHour));
        assert_eq!(fact.conditional(), ConditionalSpeedLimit::Present);
        assert_eq!(fact.variable(), VariableSpeedLimit::Variable);
        assert!(fact.is_stated());
    }

    #[test]
    fn a_modifier_can_stand_without_an_ordinary_limit() {
        // A road where the only thing anybody tagged is the exception.
        let fact = SpeedLimitFact::new(
            SpeedLimitValue::Unspecified,
            ConditionalSpeedLimit::Present,
            VariableSpeedLimit::NotTagged,
        );
        assert!(!fact.limit().is_stated());
        assert!(fact.is_stated());

        let silent = SpeedLimitFact::unspecified();
        assert!(!silent.is_stated());
        assert_eq!(silent.limit(), &SpeedLimitValue::Unspecified);
        assert_eq!(silent.conditional(), ConditionalSpeedLimit::NotTagged);
        assert_eq!(silent.variable(), VariableSpeedLimit::NotTagged);
        assert_eq!(silent, SpeedLimitFact::plain(SpeedLimitValue::Unspecified));
    }

    // -- containers ---------------------------------------------------------

    #[test]
    fn directions_are_kept_apart() {
        let limits = DirectionalSpeedLimits::new(
            SpeedLimitFact::plain(numeric("60", KilometresPerHour)),
            SpeedLimitFact::plain(numeric("40", KilometresPerHour)),
        );
        assert_eq!(limits.forward().limit(), &numeric("60", KilometresPerHour));
        assert_eq!(limits.backward().limit(), &numeric("40", KilometresPerHour));
        assert_eq!(limits.fact(SpeedDirection::Forward), limits.forward());
        assert_eq!(limits.fact(SpeedDirection::Backward), limits.backward());
        assert_ne!(limits.forward(), limits.backward());
        assert!(limits.is_stated());
    }

    #[test]
    fn every_direction_has_a_stable_wire_form() {
        assert_eq!(
            SpeedDirection::ALL
                .iter()
                .map(|direction| direction.as_str())
                .collect::<Vec<_>>(),
            vec!["forward", "backward"]
        );
        for direction in SpeedDirection::ALL {
            assert_eq!(direction.to_string(), direction.as_str());
        }
    }

    #[test]
    fn speeds_can_be_looked_up_by_mode_and_by_direction() {
        let limits = RoadSpeedLimits::new(
            DirectionalSpeedLimits::new(
                SpeedLimitFact::plain(numeric("70", KilometresPerHour)),
                SpeedLimitFact::plain(numeric("30", KilometresPerHour)),
            ),
            DirectionalSpeedLimits::uniform(SpeedLimitFact::plain(SpeedLimitValue::WalkingPace)),
            DirectionalSpeedLimits::unspecified(),
        );

        assert_eq!(
            limits
                .fact(TravelMode::Motorcar, SpeedDirection::Forward)
                .limit(),
            &numeric("70", KilometresPerHour)
        );
        assert_eq!(
            limits
                .fact(TravelMode::Motorcar, SpeedDirection::Backward)
                .limit(),
            &numeric("30", KilometresPerHour)
        );
        assert_eq!(
            limits
                .fact(TravelMode::Bicycle, SpeedDirection::Forward)
                .limit(),
            &SpeedLimitValue::WalkingPace
        );
        assert_eq!(
            limits
                .fact(TravelMode::Foot, SpeedDirection::Backward)
                .limit(),
            &SpeedLimitValue::Unspecified
        );

        // The mode accessor and the named accessors describe one value.
        for mode in TravelMode::ALL {
            let named = match mode {
                TravelMode::Motorcar => limits.motorcar(),
                TravelMode::Bicycle => limits.bicycle(),
                TravelMode::Foot => limits.foot(),
            };
            assert_eq!(limits.limits(mode), named);
            for direction in SpeedDirection::ALL {
                assert_eq!(limits.fact(mode, direction), named.fact(direction));
            }
        }
        assert!(limits.is_stated());
    }

    #[test]
    fn uniform_and_unspecified_fill_every_mode_and_direction() {
        let uniform = RoadSpeedLimits::uniform(DirectionalSpeedLimits::uniform(
            SpeedLimitFact::plain(SpeedLimitValue::NoFixedLimit),
        ));
        for mode in TravelMode::ALL {
            for direction in SpeedDirection::ALL {
                assert_eq!(
                    uniform.fact(mode, direction).limit(),
                    &SpeedLimitValue::NoFixedLimit
                );
            }
        }

        let silent = RoadSpeedLimits::unspecified();
        assert!(!silent.is_stated());
        for mode in TravelMode::ALL {
            assert!(!silent.limits(mode).is_stated());
            for direction in SpeedDirection::ALL {
                assert_eq!(silent.fact(mode, direction), &SpeedLimitFact::unspecified());
            }
        }
        assert_eq!(
            silent,
            RoadSpeedLimits::uniform(DirectionalSpeedLimits::unspecified())
        );
    }

    #[test]
    fn every_combination_of_modes_and_directions_can_stand_alone() {
        // There is no invariant between the six facts, which is why
        // construction is infallible: any combination the source can state,
        // Atlas can hold — including a bicycle limit on a road with no car
        // limit at all.
        let limits = RoadSpeedLimits::new(
            DirectionalSpeedLimits::unspecified(),
            DirectionalSpeedLimits::new(
                SpeedLimitFact::plain(numeric("25", KilometresPerHour)),
                SpeedLimitFact::unspecified(),
            ),
            DirectionalSpeedLimits::unspecified(),
        );
        assert!(!limits.motorcar().is_stated());
        assert!(limits.bicycle().is_stated());
        assert!(!limits.bicycle().backward().is_stated());
        assert!(limits.is_stated());
    }

    /// A probe for whether a concrete type implements [`Default`].
    ///
    /// Same mechanism as the one in `access.rs`: method resolution answers a
    /// question the language cannot state directly. See that module for why it
    /// is spelled as a macro at a concrete type.
    struct Probe<T>(std::marker::PhantomData<T>);

    trait DefaultedProbe {
        fn implements_default(&self) -> bool;
    }

    impl<T: Default> DefaultedProbe for &Probe<T> {
        fn implements_default(&self) -> bool {
            true
        }
    }

    trait UndefaultedProbe {
        fn implements_default(&self) -> bool;
    }

    impl<T> UndefaultedProbe for Probe<T> {
        fn implements_default(&self) -> bool {
            false
        }
    }

    macro_rules! implements_default {
        ($subject:ty) => {
            (&&Probe::<$subject>(std::marker::PhantomData)).implements_default()
        };
    }

    #[test]
    fn no_source_derived_speed_record_has_a_default() {
        // Silence is a claim about a source. A `Default` impl would let a
        // half-built feature, a forgotten field or an older adapter make that
        // claim by accident, and the result would be indistinguishable from a
        // real import that read the tags and found none.
        for (name, has_default) in [
            ("SpeedLimitValue", implements_default!(SpeedLimitValue)),
            ("SpeedLimitFact", implements_default!(SpeedLimitFact)),
            (
                "DirectionalSpeedLimits",
                implements_default!(DirectionalSpeedLimits),
            ),
            ("RoadSpeedLimits", implements_default!(RoadSpeedLimits)),
            ("Speed", implements_default!(Speed)),
            ("SpeedUnit", implements_default!(SpeedUnit)),
            ("ImplicitSpeedCode", implements_default!(ImplicitSpeedCode)),
            (
                "ConditionalSpeedLimit",
                implements_default!(ConditionalSpeedLimit),
            ),
            (
                "VariableSpeedLimit",
                implements_default!(VariableSpeedLimit),
            ),
        ] {
            assert!(!has_default, "{name} must not implement Default");
        }
        // The probe itself has to be able to see a real `Default`, or the
        // assertions above would pass for the wrong reason.
        assert!(implements_default!(u8));
        assert!(implements_default!(String));
        assert!(!implements_default!(crate::access::RoadAccess));
    }
}
