use coord_core::TenantId;
use coord_core::NodeId;
use coord_proto::MapResponse;

pub trait NetmapBuilder: Send + Sync {
    fn build(
        &self,
        tenant: TenantId,
        node: NodeId,
    ) -> impl std::future::Future<Output = Result<MapResponse, coord_core::CoordError>> + Send;
}
