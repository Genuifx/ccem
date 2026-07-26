#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::browser::login) enum EmbeddedOwnerRecoveryDisposition {
    RetainedLiveHost,
    RetainedInspectionUnknown,
    RetainedProfileLock,
    RetainedUnknownOrExternalOwner,
    RetainedProfileUnavailable,
    RecoveredLaunchPending,
    RecoveredRuntimeOwned,
    RemovedFinishedRecord,
}

impl EmbeddedOwnerRecoveryDisposition {
    pub(in crate::browser::login) const fn as_str(self) -> &'static str {
        match self {
            Self::RetainedLiveHost => "retained_live_host",
            Self::RetainedInspectionUnknown => "retained_inspection_unknown",
            Self::RetainedProfileLock => "retained_profile_lock",
            Self::RetainedUnknownOrExternalOwner => "retained_unknown_or_external_owner",
            Self::RetainedProfileUnavailable => "retained_profile_unavailable",
            Self::RecoveredLaunchPending => "recovered_launch_pending",
            Self::RecoveredRuntimeOwned => "recovered_runtime_owned",
            Self::RemovedFinishedRecord => "removed_finished_record",
        }
    }

    pub(in crate::browser::login) const fn is_retained(self) -> bool {
        matches!(
            self,
            Self::RetainedLiveHost
                | Self::RetainedInspectionUnknown
                | Self::RetainedProfileLock
                | Self::RetainedUnknownOrExternalOwner
                | Self::RetainedProfileUnavailable
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::browser::login) struct EmbeddedOwnerRecoveryRecord {
    pub(in crate::browser::login) record_id: String,
    pub(in crate::browser::login) surface_id: String,
    pub(in crate::browser::login) profile_id: String,
    pub(in crate::browser::login) workspace_identity: String,
    pub(in crate::browser::login) disposition: EmbeddedOwnerRecoveryDisposition,
}
